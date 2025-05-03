const express = require('express');
const axios = require('axios');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { Resend } = require('resend');

const app = express();
const port = process.env.PORT || 3001;

// Allow CORS
app.use(cors({
    origin: ["https://autvyn.vercel.app", "https://autovyn.net"],
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type"]
}));

// For normal API routes (vehicle info)
app.use(express.json());

// Carsimulcast API credentials
const API_KEY = 'YCGRDKUUHZTSPYMKDUJVZYUOCRFVMG';
const API_SECRET = 'o83nlvtcpwy4ajae0i17d399xgheb5iwrmzd68bm';

// Resend email service
const resend = new Resend(process.env.RESEND_API_KEY);

// Test route
app.get('/', (req, res) => {
  res.send('Autovyn backend is running.');
});

// VIN lookup route
app.get('/vehicle-info/:vin', async (req, res) => {
  const vin = req.params.vin;

  console.log("Received VIN request:", vin);

  try {
    const response = await axios.get(`https://connect.carsimulcast.com/checkrecords/${vin}`, {
      headers: {
        "API-KEY": API_KEY,
        "API-SECRET": API_SECRET,
      },
    });

    const data = response.data;
    console.log("Carsimulcast Response:", data);

    if (data && data.vehicle) {
      res.json({
        success: true,
        vin: vin,
        vehicle: data.vehicle
      });
    } else {
      res.json({
        success: false,
        message: "VIN not found or no vehicle information available."
      });
    }

  } catch (error) {
    console.error("Carsimulcast Error:", error.response ? error.response.data : error.message);
    res.status(500).json({ success: false, message: 'Error fetching vehicle info.' });
  }
});

// Stripe webhook route (ONLY raw here)
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];

  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.log('Webhook verification failed.', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;

    const customerEmail = session.customer_details.email;
    const vin = session.metadata.vin;

    console.log(`Payment received. VIN: ${vin}, Email: ${customerEmail}`);

    try {
      // Get CarFax report from Carsimulcast
      const reportResponse = await axios.get(`https://connect.carsimulcast.com/getrecord/carfax/${vin}`, {
        headers: {
          "API-KEY": API_KEY,
          "API-SECRET": API_SECRET,
        },
      });

      const reportBase64 = reportResponse.data;

      // Convert CarFax report to PDF
      const pdfResponse = await axios.post(`https://connect.carsimulcast.com/pdf/`, {
        base64_content: reportBase64,
        vin: vin,
        report_type: "carfax"
      }, {
        headers: {
          "API-KEY": API_KEY,
          "API-SECRET": API_SECRET,
        },
      });

      const pdfBase64 = pdfResponse.data;

      // Send email with PDF attachment
      await resend.emails.send({
        from: 'Autovyn <onboarding@resend.dev>',
        to: customerEmail,
        subject: `Your Autovyn Report: ${vin}`,
        html: `<p>Thank you for your purchase. Your vehicle report is attached.</p><p><strong>VIN:</strong> ${vin}</p>`,
        attachments: [
          {
            filename: `${vin}-carfax-report.pdf`,
            content: pdfBase64,
          },
        ],
      });

      console.log(`Report sent to ${customerEmail}`);

    } catch (error) {
      console.error('Error while processing report:', error.message);
    }
  }

  res.status(200).send('Webhook received');
});

// Start the server
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

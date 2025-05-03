const express = require('express');
const axios = require('axios');
const cors = require('cors');
const stripe = require('stripe')('YOUR_STRIPE_SECRET_KEY'); // REPLACE with your Stripe Secret Key
const { Resend } = require('resend');

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Carsimulcast API
const API_KEY = 'YCGRDKUUHZTSPYMKDUJVZYUOCRFVMG';
const API_SECRET = 'o83nlvtcpwy4ajae0i17d399xgheb5iwrmzd68bm';

// Resend Email API
const resend = new Resend('re_JB6sgksF_26Fr5uVVSq7zYzVKG3mKWPPZ');

// Root route
app.get('/', (req, res) => {
  res.send('Autovyn backend running.');
});

// VIN lookup route
app.get('/vehicle-info/:vin', async (req, res) => {
  const vin = req.params.vin;

  try {
    const response = await axios.get(`https://connect.carsimulcast.com/checkrecords/${vin}`, {
      headers: {
        "API-KEY": API_KEY,
        "API-SECRET": API_SECRET,
      },
    });

    const data = response.data;

    if (data.make && data.model && data.year) {
      res.json({
        success: true,
        vin: vin,
        make: data.make,
        model: data.model,
        year: data.year
      });
    } else {
      res.json({
        success: false,
        message: "VIN not found or no vehicle information available."
      });
    }

  } catch (error) {
    console.error(error.response ? error.response.data : error.message);
    res.status(500).json({ success: false, message: 'Error fetching vehicle info.' });
  }
});

// Stripe webhook
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];

  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, 'YOUR_STRIPE_WEBHOOK_SECRET'); // Replace this with your webhook secret
  } catch (err) {
    console.log('Webhook verification failed.', err.message);
    return res.sendStatus(400);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;

    const customerEmail = session.customer_details.email;
    const vin = session.metadata.vin;

    console.log(`Payment received. VIN: ${vin}, Email: ${customerEmail}`);

    try {
      // Pull CarFax report
      const reportResponse = await axios.get(`https://connect.carsimulcast.com/getrecord/carfax/${vin}`, {
        headers: {
          "API-KEY": API_KEY,
          "API-SECRET": API_SECRET,
        },
      });

      const reportBase64 = reportResponse.data;

      // Convert to PDF
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

      // Send email
      await resend.emails.send({
        from: 'Autovyn <onboarding@resend.dev>',
        to: customerEmail,
        subject: `Your Autovyn Report: ${vin}`,
        html: `<p>Thank you for your purchase. Your vehicle report is attached.</p>
               <p><strong>VIN:</strong> ${vin}</p>`,
        attachments: [
          {
            filename: `${vin}-carfax-report.pdf`,
            content: pdfBase64,
          },
        ],
      });

      console.log(`Report sent to ${customerEmail}`);

    } catch (error) {
      console.error('Error during report process:', error.message);
    }
  }

  res.status(200).send('Webhook received');
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

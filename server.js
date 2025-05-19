const express = require('express');
const axios = require('axios');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { Resend } = require('resend');

const app = express();
const port = process.env.PORT || 3001;

const API_KEY = process.env.REPORT_PROVIDER_API;
const API_SECRET = process.env.REPORT_PROVIDER_SECRET;
const resend = new Resend(process.env.RESEND_API_KEY);

// ✅ Stripe webhook — MUST come first (raw body)
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.log('Webhook verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const vin = session.metadata.vin;
    const customerEmail = session.metadata.email;
    const vehicleInfo = session.metadata.vehicle;

    console.log(`✅ Payment successful: VIN ${vin}, Email ${customerEmail}`);

    try {
      const pdfLink = await generateReportPDF(vin, vehicleInfo);

      if (pdfLink) {
        await resend.emails.send({
          from: 'Autovyn <autovynsupport@autovyn.net>',
          to: customerEmail,
          subject: `Your Autovyn Report for ${vehicleInfo} (VIN: ${vin})`,
          html: `
            <p>Thank you for your purchase!</p>
            <p>Your verified Carfax report is ready:</p>
            <p><a href="${pdfLink}" target="_blank">${pdfLink}</a></p>
          `
        });

        console.log(`📧 Email sent with PDF link: ${pdfLink}`);
      } else {
        console.log('❌ Report PDF generation failed.');
      }

    } catch (err) {
      console.error('❌ Error handling post-payment:', err.message);
    }
  }

  res.status(200).send('Webhook received');
});

// ✅ Apply middleware AFTER webhook
app.use(express.json());
app.use(cors({
  origin: ["https://autovyn.net", "https://www.autovyn.net"],
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type"]
}));

// ✅ Home route
app.get('/', (req, res) => {
  res.send('Autovyn backend is running.');
});

// ✅ VIN info before payment
app.get('/vehicle-info/:vin', async (req, res) => {
  const vin = req.params.vin;

  try {
    const response = await axios.get(`https://connect.carsimulcast.com/checkrecords/${vin}`, {
      headers: {
        "API-KEY": API_KEY,
        "API-SECRET": API_SECRET
      }
    });

    const data = response.data;
    if (data?.vehicle) {
      res.json({ success: true, vin, vehicle: data.vehicle });
    } else {
      res.json({ success: false, message: "VIN not found or no vehicle information available." });
    }

  } catch (error) {
    console.error("VIN lookup failed:", error.message);
    res.status(500).json({ success: false, message: 'Server error while checking VIN.' });
  }
});

// ✅ Create Stripe checkout session
app.post('/create-checkout-session', async (req, res) => {
  const { vin, email, vehicle } = req.body;

  try {
    const pdfLink = await generateReportPDF(vin, vehicle);

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: `Autovyn Carfax Report - ${vehicle} (VIN: ${vin})`
          },
          unit_amount: 399
        },
        quantity: 1
      }],
      metadata: { vin, email, vehicle },
      success_url: `https://autovyn.net/report.html?vin=${vin}&email=${email}&carfax=${encodeURIComponent(pdfLink || '')}`,
      cancel_url: 'https://autovyn.net/?status=cancel'
    });

    res.json({ url: session.url });

  } catch (error) {
    console.error("Checkout session error:", error.message);
    res.status(500).send('Failed to create payment session');
  }
});

// ✅ Contact form
app.post('/contact', async (req, res) => {
  const { name, email, vin, message } = req.body;

  try {
    await resend.emails.send({
      from: 'Autovyn Contact <autovynsupport@autovyn.net>',
      to: 'autovynsupport@autovyn.net',
      subject: `Customer Message from ${name}`,
      html: `
        <p><strong>Name:</strong> ${name}</p>
        <p><strong>Email:</strong> ${email}</p>
        <p><strong>VIN:</strong> ${vin}</p>
        <p><strong>Message:</strong><br>${message}</p>
      `
    });

    res.json({ success: true });
  } catch (err) {
    console.error('Contact form failed:', err.message);
    res.status(500).json({ success: false, message: 'Failed to send contact message' });
  }
});

// ✅ Generate report PDF and get link
async function generateReportPDF(vin, vehicleName) {
  try {
    const recordRes = await axios.get(`https://connect.carsimulcast.com/getrecord/carfax/${vin}`, {
      headers: {
        "API-KEY": API_KEY,
        "API-SECRET": API_SECRET
      }
    });

    const base64Content = recordRes.data;

    if (!base64Content || typeof base64Content !== 'string') {
      console.log("❌ Base64 report content missing or invalid.");
      return null;
    }

    const pdfRes = await axios.post('https://connect.carsimulcast.com/pdf', {
      base64_content: base64Content,
      report_type: "carfax",
      vehicle_name: vehicleName,
      vin
    }, {
      headers: {
        "API-KEY": API_KEY,
        "API-SECRET": API_SECRET
      }
    });

    console.log("📦 Full PDF API response:", pdfRes.data);

    const pdfLink = pdfRes.data?.url;
    if (pdfLink) {
      console.log("✅ PDF link created:", pdfLink);
      return pdfLink;
    }

    console.log("❌ PDF response missing URL.");
    return null;

  } catch (err) {
    console.error("❌ Error converting to PDF:", err.message);
    return null;
  }
}

// ✅ Start server
app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});

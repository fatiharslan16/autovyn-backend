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

// ✅ Middleware
app.use(express.json());
app.use(cors({
  origin: ["https://autovyn.net", "https://www.autovyn.net"],
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type"]
}));

// ✅ Home
app.get('/', (req, res) => {
  res.send('Autovyn backend is running.');
});

// ✅ VIN info preview before payment
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
      res.json({ success: false, message: "VIN not found." });
    }

  } catch (err) {
    console.error("VIN lookup failed:", err.message);
    res.status(500).json({ success: false, message: "Server error while checking VIN." });
  }
});

// ✅ Create Stripe checkout session
app.post('/create-checkout-session', async (req, res) => {
  const { vin, email, vehicle } = req.body;

  try {
    const reportLink = await getReportPDFLink(vin, vehicle);

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name: `Autovyn Carfax Report - ${vehicle} (VIN: ${vin})` },
          unit_amount: 399
        },
        quantity: 1
      }],
      metadata: { vin, email, vehicle, reportLink },
      success_url: `https://autovyn.net/report.html?vin=${vin}&email=${email}&carfax=${encodeURIComponent(reportLink || '')}`,
      cancel_url: 'https://autovyn.net/?status=cancel'
    });

    res.json({ url: session.url });

  } catch (err) {
    console.error("❌ Error creating checkout session:", err.message);
    res.status(500).send("Failed to create checkout session");
  }
});

// ✅ Stripe webhook: send email with PDF after payment
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const { vin, email, vehicle, reportLink } = session.metadata;

    console.log(`✅ Payment success: VIN ${vin}, Email ${email}`);

    if (reportLink) {
      try {
        await resend.emails.send({
          from: 'Autovyn <autovynsupport@autovyn.net>',
          to: email,
          subject: `Your Autovyn Report for ${vehicle} (VIN: ${vin})`,
          html: `
            <p>Thank you for your purchase!</p>
            <p>Your verified report is ready:</p>
            <p><a href="${reportLink}/pdf" target="_blank">${reportLink}/pdf</a></p>
          `
        });

        console.log(`📧 Report sent to ${email}: ${reportLink}/pdf`);

      } catch (err) {
        console.error("❌ Failed to send report email:", err.message);
      }
    } else {
      console.log("❌ Report link not found after payment.");
    }
  }

  res.status(200).send('Webhook received');
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
    console.error("❌ Contact form error:", err.message);
    res.status(500).json({ success: false, message: "Failed to send message." });
  }
});

// ✅ Get base64 report and convert to hosted link
async function getReportPDFLink(vin, vehicleName) {
  try {
    const recordRes = await axios.get(`https://connect.carsimulcast.com/getrecord/carfax/${vin}`, {
      headers: {
        "API-KEY": API_KEY,
        "API-SECRET": API_SECRET
      }
    });

    const base64 = recordRes.data;
    if (!base64 || typeof base64 !== 'string') {
      console.log("❌ Invalid report data received.");
      return null;
    }

    const pdfRes = await axios.post('https://connect.carsimulcast.com/pdf', {
      base64_content: base64,
      vin,
      vehicle_name: vehicleName,
      report_type: 'carfax'
    }, {
      headers: {
        "API-KEY": API_KEY,
        "API-SECRET": API_SECRET
      }
    });

    const url = pdfRes.data?.url;
    if (url) {
      console.log("✅ Report link generated:", url);
      return url;
    }

    console.log("❌ PDF response missing URL.");
    return null;

  } catch (err) {
    console.error("❌ Failed to generate report PDF:", err.message);
    return null;
  }
}

// ✅ Start server
app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});

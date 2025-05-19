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

// Raw body middleware for Stripe
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
      const pdfLink = await getCarfaxPDFLink(vin);
      if (pdfLink) {
        await resend.emails.send({
          from: 'Autovyn <autovynsupport@autovyn.net>',
          to: customerEmail,
          subject: `Your Autovyn Report for ${vehicleInfo} (VIN: ${vin})`,
          html: `<p>Your Carfax report is ready:</p><a href="${pdfLink}" target="_blank">${pdfLink}</a>`
        });
        console.log(`📧 Sent report email with PDF: ${pdfLink}`);
      } else {
        console.log('❌ Report link not found after payment.');
      }
    } catch (err) {
      console.error('❌ Error processing payment:', err.message);
    }
  }

  res.status(200).send('Webhook handled');
});

// Middleware
app.use(express.json());
app.use(cors({
  origin: ['https://autovyn.net', 'https://www.autovyn.net'],
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type']
}));

app.get('/', (req, res) => {
  res.send('Autovyn backend running.');
});

// VIN info
app.get('/vehicle-info/:vin', async (req, res) => {
  const vin = req.params.vin;
  try {
    const response = await axios.get(`https://connect.carsimulcast.com/checkrecords/${vin}`, {
      headers: { "API-KEY": API_KEY, "API-SECRET": API_SECRET }
    });

    if (response.data?.vehicle) {
      res.json({ success: true, vin, vehicle: response.data.vehicle });
    } else {
      res.json({ success: false, message: 'No vehicle data' });
    }
  } catch (err) {
    console.error('❌ VIN info error:', err.message);
    res.status(500).json({ success: false });
  }
});

// Stripe checkout
app.post('/create-checkout-session', async (req, res) => {
  const { vin, email, vehicle } = req.body;

  try {
    const carfaxLink = await getCarfaxPDFLink(vin);
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
      success_url: `https://autovyn.net/report.html?link=${encodeURIComponent(carfaxLink || '')}`,
      cancel_url: 'https://autovyn.net/?status=cancel'
    });

    res.json({ url: session.url });

  } catch (error) {
    console.error('❌ Stripe session error:', error.message);
    res.status(500).send('Checkout session failed');
  }
});

// Helper: Get Carfax report link (no base64)
async function getCarfaxPDFLink(vin) {
  try {
    const res = await axios.get(`https://connect.carsimulcast.com/checkrecords/${vin}`, {
      headers: { "API-KEY": API_KEY, "API-SECRET": API_SECRET }
    });

    const carfaxLink = res.data?.carfax_link;
    if (carfaxLink) {
      console.log("✅ Carfax link found:", carfaxLink);
      return `${carfaxLink}/pdf`;
    }

    console.log("❌ carfax_link missing from checkrecords");
    return null;
  } catch (err) {
    console.error("❌ Error getting Carfax link:", err.message);
    return null;
  }
}

app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { Resend } = require('resend');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');

const app = express();
const port = process.env.PORT || 3001;

// Supabase setup
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Config
const API_KEY = process.env.REPORT_PROVIDER_API;
const API_SECRET = process.env.REPORT_PROVIDER_SECRET;
const resend = new Resend(process.env.RESEND_API_KEY);
const BUCKET_NAME = 'autovynreports';

// ✅ CORS
app.use(cors({
  origin: ["https://autovyn.net", "https://www.autovyn.net"],
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type"]
}));

// ✅ Stripe Webhook
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
    const vin = session.metadata.vin;
    const customerEmail = session.metadata.email;
    const vehicleInfo = session.metadata.vehicle;

    console.log(`✅ Payment received for VIN: ${vin}, Email: ${customerEmail}`);

    try {
      // 1. Fetch base64 HTML
      console.log("🔍 Fetching Carfax HTML base64...");
      const carfaxRes = await axios.get(`https://connect.carsimulcast.com/getrecord/carfax/${vin}`, {
        headers: { "API-KEY": API_KEY, "API-SECRET": API_SECRET }
      });

      const base64Html = carfaxRes.data;
      console.log("✅ Got base64 HTML. Length:", base64Html.length);

      // 2. Send to /pdf endpoint
      console.log("📦 Converting HTML to PDF via Carsimulcast...");
      const pdfRes = await axios.post(
        "https://connect.carsimulcast.com/pdf",
        {
          base64_content: base64Html,
          report_type: "carfax",
          vehicle_name: vehicleInfo,
          vin: vin
        },
        {
          headers: {
            "API-KEY": API_KEY,
            "API-SECRET": API_SECRET
          }
        }
      );

      const base64Pdf = pdfRes.data?.pdf || pdfRes.data;
      const isBase64 = /^[A-Za-z0-9+/=\r\n]+$/.test(base64Pdf.slice(0, 100));
      console.log("✅ Received PDF. Is base64 valid?", isBase64);
      console.log("📏 PDF base64 length:", base64Pdf.length);

      // 3. Convert and save locally for debugging
      const pdfBuffer = Buffer.from(base64Pdf, 'base64');
      const localPath = `./${vin}.pdf`;
      fs.writeFileSync(localPath, pdfBuffer);
      console.log("💾 Saved local test file:", localPath);

      // 4. Upload to Supabase
      const filename = `${vin}-${Date.now()}.pdf`;
      console.log("☁️ Uploading PDF to Supabase:", filename);
      await supabase.storage
        .from(BUCKET_NAME)
        .upload(filename, pdfBuffer, {
          contentType: 'application/pdf',
          upsert: false
        });

      const { data } = supabase.storage.from(BUCKET_NAME).getPublicUrl(filename);
      const publicUrl = data.publicUrl;
      console.log("🔗 Public Supabase URL:", publicUrl);

      // 5. Email the link
      await resend.emails.send({
        from: 'Autovyn <autovynsupport@autovyn.net>',
        to: customerEmail,
        subject: `Your Autovyn Report for ${vehicleInfo} (VIN: ${vin})`,
        html: `<p>Thanks for your purchase!</p>
               <p>Your PDF report is ready:</p>
               <p><a href="${publicUrl}" target="_blank">Download Report</a></p>`
      });

      console.log(`📧 Email sent to: ${customerEmail}`);
    } catch (error) {
      console.error('❌ Error during report processing:', error.message);
    }
  }

  res.status(200).send('Webhook received');
});

// ✅ Enable JSON after webhook
app.use(express.json());

// ✅ Home route
app.get('/', (req, res) => {
  res.send('Autovyn backend is running.');
});

// ✅ VIN lookup
app.get('/vehicle-info/:vin', async (req, res) => {
  const vin = req.params.vin;
  console.log("🔍 VIN Lookup:", vin);

  try {
    const response = await axios.get(`https://connect.carsimulcast.com/checkrecords/${vin}`, {
      headers: {
        "API-KEY": API_KEY,
        "API-SECRET": API_SECRET,
      },
    });

    const data = response.data;

    if (data && data.vehicle) {
      res.json({ success: true, vin, vehicle: data.vehicle });
    } else {
      res.json({ success: false, message: "VIN not found or no vehicle information available." });
    }
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error fetching vehicle info.' });
  }
});

// ✅ Stripe Checkout session
app.post('/create-checkout-session', async (req, res) => {
  const { vin, email, vehicle } = req.body;

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: `Autovyn Carfax Report - ${vehicle} (VIN: ${vin})`,
          },
          unit_amount: 399,
        },
        quantity: 1,
      }],
      metadata: { vin, email, vehicle },
      success_url: `https://autovyn.net/report.html?vin=${vin}&email=${email}`,
      cancel_url: 'https://autovyn.net/?status=cancel',
    });

    res.json({ url: session.url });
  } catch (error) {
    console.error(error.message);
    res.status(500).send('Internal Server Error');
  }
});

// ✅ Customer Contact Form
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
    console.error('Error sending contact form:', err);
    res.status(500).json({ success: false, message: 'Failed to send message' });
  }
});

app.listen(port, () => {
  console.log(`🚀 Autovyn backend running on port ${port}`);
});

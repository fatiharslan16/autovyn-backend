const express = require('express');
const axios = require('axios');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { Resend } = require('resend');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');

const app = express();
const port = process.env.PORT || 3001;

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

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
    console.log('❌ Webhook verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const vin = session.metadata.vin;
    const customerEmail = session.metadata.email;
    const vehicleInfo = session.metadata.vehicle;

    console.log(`✅ Payment received for VIN: ${vin}, Email: ${customerEmail}`);

    try {
      // 1. Get base64 HTML
      console.log('🔍 Fetching Carfax HTML base64...');
      const carfaxRes = await axios.get(`https://connect.carsimulcast.com/getrecord/carfax/${vin}`, {
        headers: { "API-KEY": API_KEY, "API-SECRET": API_SECRET }
      });

      const base64Html = carfaxRes.data;
      console.log('✅ Got base64 HTML. Length:', base64Html.length);

      // 2. Convert to PDF
      console.log('📦 Converting HTML to PDF via Carsimulcast...');
      const pdfRes = await axios.post(
        'https://connect.carsimulcast.com/pdf/',
        {
          base64_content: base64Html,
          report_type: "carfax",
          vin: vin,
          vehicle_name: vehicleInfo
        },
        {
          headers: {
            "API-KEY": API_KEY,
            "API-SECRET": API_SECRET
          }
        }
      );

      const base64Pdf = pdfRes.data;
      const isBase64 = /^[A-Za-z0-9+/=\n\r]+$/.test(base64Pdf.slice(0, 100));
      console.log('✅ Received PDF. Is base64 valid?', isBase64);
      console.log('📏 PDF base64 length:', base64Pdf.length);

      const pdfBuffer = Buffer.from(base64Pdf, 'base64');

      // Optional: Save locally to test
      const localPath = `./${vin}.pdf`;
      fs.writeFileSync(localPath, pdfBuffer);
      console.log(`💾 Saved local test file: ${localPath}`);

      // 3. Upload to Supabase
      const filename = `${vin}-${Date.now()}.pdf`;
      console.log('☁️ Uploading PDF to Supabase:', filename);

      const { error: uploadError } = await supabase.storage
        .from(BUCKET_NAME)
        .upload(filename, pdfBuffer, {
          contentType: 'application/pdf',
          upsert: false
        });

      if (uploadError) throw new Error('📤 Supabase upload error: ' + uploadError.message);

      const { data } = supabase.storage
        .from(BUCKET_NAME)
        .getPublicUrl(filename);

      const publicUrl = data?.publicUrl;
      console.log('🔗 Public Supabase URL:', publicUrl);

      // 4. Send Email
      await resend.emails.send({
        from: 'Autovyn <autovynsupport@autovyn.net>',
        to: customerEmail,
        subject: `Your Autovyn PDF Report for ${vehicleInfo} (VIN: ${vin})`,
        html: `<p>Thanks for your purchase!</p>
               <p>Your PDF report is ready:</p>
               <p><a href="${publicUrl}" target="_blank">Download Report</a></p>`
      });

      console.log('📧 Email sent to:', customerEmail);
    } catch (err) {
      console.error('❌ Error during processing:', err.message);
    }
  }

  res.status(200).send('Webhook received');
});

// ✅ Enable JSON
app.use(express.json());

// ✅ VIN Lookup
app.get('/vehicle-info/:vin', async (req, res) => {
  const vin = req.params.vin;
  console.log("🔍 VIN Lookup:", vin);

  try {
    const response = await axios.get(`https://connect.carsimulcast.com/checkrecords/${vin}`, {
      headers: { "API-KEY": API_KEY, "API-SECRET": API_SECRET },
    });

    const data = response.data;
    if (data?.vehicle) {
      res.json({ success: true, vin, vehicle: data.vehicle });
    } else {
      res.json({ success: false, message: "No vehicle found." });
    }
  } catch (error) {
    res.status(500).json({ success: false, message: 'API error' });
  }
});

// ✅ Stripe Checkout
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

// ✅ Contact
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
    console.error('Contact form error:', err);
    res.status(500).json({ success: false, message: 'Failed to send' });
  }
});

app.listen(port, () => {
  console.log(`🚀 Autovyn backend running on port ${port}`);
});

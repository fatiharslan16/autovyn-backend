const express = require('express');
const axios = require('axios');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { Resend } = require('resend');
const fs = require('fs');
const path = require('path');

const app = express();
const port = process.env.PORT || 3001;

// Carsimulcast API credentials
const API_KEY = 'YCGRDKUUHZTSPYMKDUJVZYUOCRFVMG';
const API_SECRET = 'o83nlvtcpwy4ajae0i17d399xgheb5iwrmzd68bm';

// Resend email service
const resend = new Resend(process.env.RESEND_API_KEY);

// Make reports folder if not exist
const reportsDir = path.join(__dirname, 'reports');
if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir);
}

// ✅ Webhook - important for Stripe payments
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

        console.log(`Payment received. VIN: ${vin}, Email: ${customerEmail}`);

        try {
            // Step 1: Pull records
            const recordsResponse = await axios.get(`https://connect.carsimulcast.com/checkrecords/${vin}`, {
                headers: {
                    "API-KEY": API_KEY,
                    "API-SECRET": API_SECRET,
                },
            });

            const records = recordsResponse.data;

            if (!records.carfax_available) {
                console.log('Carfax report not available yet');
                return res.status(200).send("Carfax report not available yet");
            }

            // Step 2: Pull Carfax report
            const reportResponse = await axios.get(`https://connect.carsimulcast.com/getrecord/carfax/${vin}`, {
                headers: {
                    "API-KEY": API_KEY,
                    "API-SECRET": API_SECRET,
                },
            });

            const reportBase64 = reportResponse.data;

            if (!reportBase64 || reportBase64.length < 1000) {
                console.error('Invalid or empty report received.');
                return res.status(200).send("Report is still generating. Will email when ready.");
            }

            // Step 3: Convert to PDF
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

            const rawPdfBase64 = pdfResponse.data;
            const cleanedPdfBase64 = rawPdfBase64.replace(/(\r\n|\n|\r)/gm, "").trim();
            const pdfBuffer = Buffer.from(cleanedPdfBase64, 'base64');

            // ✅ SAVE PDF
            const filePath = path.join(reportsDir, `${vin}.pdf`);
            fs.writeFileSync(filePath, pdfBuffer);
            console.log(`PDF saved: ${filePath}`);

            // ✅ Send email
            await resend.emails.send({
                from: 'Autovyn <onboarding@resend.dev>',
                to: customerEmail,
                subject: `Your Autovyn Report: ${vin}`,
                html: `<p>Thank you for your purchase. You can also download your report <a href="https://autovyn-backend.onrender.com/report/${vin}">here</a>.</p>`,
                attachments: [
                    {
                        filename: `${vin}-carfax-report.pdf`,
                        content: pdfBuffer,
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

// ✅ CORS setup (Only autovyn-frontend.vercel.app now)
app.use(cors({
    origin: ["https://autovyn-frontend.vercel.app"],
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type"]
}));

app.use(express.json());

// Home
app.get('/', (req, res) => {
    res.send('Autovyn backend is running.');
});

// VIN lookup
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
        res.status(500).json({ success: false, message: 'Error fetching vehicle info.' });
    }
});

// ✅ Serve PDF report
app.get('/report/:vin', (req, res) => {
    const vin = req.params.vin;
    const filePath = path.join(reportsDir, `${vin}.pdf`);

    if (fs.existsSync(filePath)) {
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="${vin}-report.pdf"`);
        fs.createReadStream(filePath).pipe(res);
    } else {
        res.status(404).send("Report not found yet. Please try again later.");
    }
});

// ✅ Stripe Checkout Session
app.post('/create-checkout-session', async (req, res) => {
    const { vin, email } = req.body;

    try {
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            mode: 'payment',
            line_items: [
                {
                    price_data: {
                        currency: 'usd',
                        product_data: {
                            name: `Autovyn Report for VIN: ${vin}`,
                        },
                        unit_amount: 299, // $2.99
                    },
                    quantity: 1,
                },
            ],
            metadata: {
                vin: vin,
                email: email
            },
            success_url: `https://autovyn-frontend.vercel.app/report.html?vin=${vin}`,
            cancel_url: 'https://autovyn-frontend.vercel.app/?status=cancel',
        });

        res.json({ url: session.url });
    } catch (error) {
        res.status(500).send('Internal Server Error');
    }
});

// Start server
app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { Resend } = require('resend');
const fs = require('fs');
const path = require('path');

const app = express();
const port = process.env.PORT || 3001;

// Carsimulcast API credentials from environment variables
const API_KEY = process.env.REPORT_PROVIDER_API;
const API_SECRET = process.env.REPORT_PROVIDER_SECRET;

// Resend email service
const resend = new Resend(process.env.RESEND_API_KEY);

// Create reports folder if not exists
const reportsDir = path.join(__dirname, 'reports');
if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir);
}

// ✅ Stripe webhook
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

        console.log(`Payment received. VIN: ${vin}, Email: ${customerEmail}`);

        try {
            // Check latest records to get carfax link
            const recordsResponse = await axios.get(`https://connect.carsimulcast.com/checkrecords/${vin}`, {
                headers: {
                    "API-KEY": API_KEY,
                    "API-SECRET": API_SECRET,
                },
            });

            const records = recordsResponse.data;

            if (!records.carfax_link) {
                console.log('Carfax link not available yet.');
                return res.status(200).send("Carfax link not available yet");
            }

            const carfaxLink = records.carfax_link;

            // ✅ Send email with link
            await resend.emails.send({
                from: 'Autovyn <onboarding@resend.dev>',
                to: customerEmail,
                subject: `Your Autovyn Report for ${vehicleInfo} (VIN: ${vin})`,
                html: `<p>Thank you for your purchase.</p>
                       <p><strong>Vehicle:</strong> ${vehicleInfo} (VIN: ${vin})</p>
                       <p>Your Carfax report is ready: <a href="${carfaxLink}" target="_blank">View Report</a></p>`,
            });

            console.log(`Report link sent to ${customerEmail}`);

        } catch (error) {
            console.error('Error while processing report:', error.message);
        }
    }

    res.status(200).send('Webhook received');
});

// ✅ CORS (frontend domain fixed)
app.use(cors({
    origin: ["https://autovyn.net", "https://www.autovyn.net"],
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type"]
}));

app.use(express.json());

// ✅ Home test route
app.get('/', (req, res) => {
    res.send('Autovyn backend is running.');
});

// ✅ VIN lookup
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

// ✅ Redirect to Carfax link or show error
app.get('/report/:vin', async (req, res) => {
    const vin = req.params.vin;

    try {
        const recordsResponse = await axios.get(`https://connect.carsimulcast.com/checkrecords/${vin}`, {
            headers: {
                "API-KEY": API_KEY,
                "API-SECRET": API_SECRET,
            },
        });

        const data = recordsResponse.data;

        if (data && data.carfax_link) {
            res.redirect(data.carfax_link);
        } else {
            res.status(404).send("Report not available yet.");
        }

    } catch (error) {
        res.status(500).send("Error fetching report link.");
    }
});

// ✅ Stripe checkout session
app.post('/create-checkout-session', async (req, res) => {
    const { vin, email, vehicle } = req.body;

    try {
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            mode: 'payment',
            line_items: [
                {
                    price_data: {
                        currency: 'usd',
                        product_data: {
                            name: `Autovyn Carfax Report - ${vehicle} (VIN: ${vin})`,
                        },
                        unit_amount: 299,
                    },
                    quantity: 1,
                },
            ],
            metadata: {
                vin: vin,
                email: email,
                vehicle: vehicle
            },
            success_url: `https://autovyn.net/report.html?vin=${vin}`,
            cancel_url: 'https://autovyn.net/?status=cancel',
        });

        res.json({ url: session.url });
    } catch (error) {
        res.status(500).send('Internal Server Error');
    }
});

// ✅ Start server
app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});

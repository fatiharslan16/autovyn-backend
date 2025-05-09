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

        console.log(`Payment received. VIN: ${vin}, Email: ${customerEmail}`);

        try {
            await resend.emails.send({
                from: 'Autovyn Contact <autovynsupport@autovyn.net>',
                to: customerEmail,
                subject: `Your Autovyn Report for ${vehicleInfo} (VIN: ${vin})`,
                html: `<p>Thank you for your purchase!</p>
                       <p>Your report will be ready soon. You can download it using the link below:</p>
                       <p><a href="https://autovyn-backend.onrender.com/report/${vin}?email=${customerEmail}" target="_blank">Download/View Your Report</a></p>`
            });

            console.log(`Report link email sent to ${customerEmail}`);
        } catch (error) {
            console.error('Error sending email:', error.message);
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

// ✅ VIN info lookup
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
            res.json({ success: true, vin, vehicle: data.vehicle });
        } else {
            res.json({ success: false, message: "VIN not found or no vehicle information available." });
        }

    } catch (error) {
        res.status(500).json({ success: false, message: 'Error fetching vehicle info.' });
    }
});

// ✅ Report download route
app.get('/report/:vin', async (req, res) => {
    const vin = req.params.vin;
    const email = req.query.email;

    try {
        const recordsResponse = await axios.get(`https://connect.carsimulcast.com/checkrecords/${vin}`, {
            headers: {
                "API-KEY": API_KEY,
                "API-SECRET": API_SECRET,
            },
        });

        const data = recordsResponse.data;

        if (data && data.carfax_link) {
            if (email) {
                await resend.emails.send({
                    from: 'Autovyn Contact <autovynsupport@autovyn.net>',
                    to: email,
                    subject: `Your Autovyn Report (VIN: ${vin}) is ready`,
                    html: `<p>Your report is ready. Click below to view/download:</p>
                           <p><a href="${data.carfax_link}" target="_blank">View Report</a></p>`
                });
                console.log(`Carfax link email sent to ${email}`);
            }

            return res.redirect(data.carfax_link);
        }

        const carfaxResponse = await axios.get(`https://connect.carsimulcast.com/getrecord/carfax/${vin}`, {
            headers: {
                "API-KEY": API_KEY,
                "API-SECRET": API_SECRET,
            },
        });

        const reportContent = carfaxResponse.data;

        if (reportContent && reportContent !== "No record found") {
            if (email) {
                await resend.emails.send({
                    from: 'Autovyn Contact <autovynsupport@autovyn.net>',
                    to: email,
                    subject: `Your Autovyn Report (VIN: ${vin}) is ready`,
                    html: `<p>Your report is ready. Click below to view/download:</p>
                           <p><a href="https://autovyn-backend.onrender.com/report/${vin}?email=${email}" target="_blank">View Report</a></p>`
                });
                console.log(`HTML report email link sent to ${email}`);
            }

            res.setHeader("Content-Type", "text/html");
            return res.send(Buffer.from(reportContent, 'base64').toString('utf-8'));
        } else {
            return res.status(404).send("Report not available yet.");
        }

    } catch (error) {
        console.error(error.message);
        res.status(500).send("Error fetching report.");
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

// ✅ Contact Form (customer support message)
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
    console.log(`Server running on port ${port}`);
});

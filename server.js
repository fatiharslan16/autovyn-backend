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

app.use(cors({
    origin: ["https://autovyn.net", "https://www.autovyn.net"],
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type"]
}));

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
            await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds

            const response = await axios.get(`https://connect.carsimulcast.com/checkrecords/${vin}`, {
                headers: {
                    "API-KEY": API_KEY,
                    "API-SECRET": API_SECRET,
                },
            });

            const link = response.data?.carfax_link;

            if (link) {
                await resend.emails.send({
                    from: 'Autovyn Contact <autovynsupport@autovyn.net>',
                    to: customerEmail,
                    subject: `Your Autovyn Report for ${vehicleInfo} (VIN: ${vin})`,
                    html: `<p>Thank you for your purchase!</p>
                           <p>Your report is ready in PDF format:</p>
                           <p><a href="${link}/pdf" target="_blank">${link}/pdf</a></p>`
                });

                console.log(`Email sent with Carfax link: ${link}/pdf`);
            } else {
                console.log('Carfax link missing in response');
            }
        } catch (error) {
            console.error('Error after payment:', error.message);
        }
    }

    res.status(200).send('Webhook received');
});

app.use(express.json());

app.get('/', (req, res) => {
    res.send('Autovyn backend is running.');
});

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

app.post('/create-checkout-session', async (req, res) => {
    const { vin, email, vehicle } = req.body;

    try {
        const response = await axios.get(`https://connect.carsimulcast.com/checkrecords/${vin}`, {
            headers: {
                "API-KEY": API_KEY,
                "API-SECRET": API_SECRET,
            },
        });

        const carfaxLink = response.data?.carfax_link;

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
            success_url: `https://autovyn.net/report.html?vin=${vin}&email=${email}&carfax=${encodeURIComponent(carfaxLink)}`,
            cancel_url: 'https://autovyn.net/?status=cancel',
        });

        res.json({ url: session.url });
    } catch (error) {
        console.error(error.message);
        res.status(500).send('Internal Server Error');
    }
});

// Contact form (optional)
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

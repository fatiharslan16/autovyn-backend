const express = require('express');
const axios = require('axios');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { Resend } = require('resend');
const fs = require('fs');
const path = require('path');

const app = express(); // ✅ THIS LINE MUST COME BEFORE ANY app.post()

const port = process.env.PORT || 3001;

const API_KEY = process.env.REPORT_PROVIDER_API;
const API_SECRET = process.env.REPORT_PROVIDER_SECRET;
const resend = new Resend(process.env.RESEND_API_KEY);


// Stripe Webhook
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

        const pdfPath = path.join(__dirname, 'reports', `${vin}.pdf`);

        try {
            // If already cached, send the file without refetching
            if (fs.existsSync(pdfPath)) {
                const pdfBuffer = fs.readFileSync(pdfPath);
                await resend.emails.send({
                    from: 'Autovyn Contact <autovynsupport@autovyn.net>',
                    to: customerEmail,
                    subject: `Your Autovyn Report for ${vehicleInfo} (VIN: ${vin})`,
                    html: `<p>Thank you for your purchase!</p><p>Your vehicle report is attached as a PDF.</p>`,
                    attachments: [
                        {
                            filename: `${vin}.pdf`,
                            content: pdfBuffer.toString('base64'),
                            type: 'application/pdf',
                        }
                    ]
                });
                console.log(`PDF report (cached) sent to ${customerEmail}`);
                return res.status(200).send('Webhook processed');
            }

            // Step 1: Get base64 Carfax report
            const carfaxResponse = await axios.get(`https://connect.carsimulcast.com/getrecord/carfax/${vin}`, {
                headers: {
                    "API-KEY": process.env.REPORT_PROVIDER_API,
                    "API-SECRET": process.env.REPORT_PROVIDER_SECRET,
                },
            });

            const base64Html = carfaxResponse.data;
            if (!base64Html || base64Html === "No record found") {
                throw new Error("No report found");
            }

            // Step 2: Convert to PDF
            const pdfResponse = await axios.post(`https://connect.carsimulcast.com/pdf/`, null, {
                headers: {
                    "API-KEY": process.env.REPORT_PROVIDER_API,
                    "API-SECRET": process.env.REPORT_PROVIDER_SECRET,
                },
                params: {
                    base64_content: base64Html,
                    vin: vin,
                    report_type: "carfax",
                    vehicle_name: vehicleInfo
                },
                responseType: 'arraybuffer'
            });

            const pdfBuffer = Buffer.from(pdfResponse.data, 'binary');

            // Step 3: Save locally
            fs.mkdirSync(path.join(__dirname, 'reports'), { recursive: true });
            fs.writeFileSync(pdfPath, pdfBuffer);

            // Step 4: Send via email
            await resend.emails.send({
                from: 'Autovyn Contact <autovynsupport@autovyn.net>',
                to: customerEmail,
                subject: `Your Autovyn Report for ${vehicleInfo} (VIN: ${vin})`,
                html: `<p>Thank you for your purchase!</p><p>Your vehicle report is attached as a PDF.</p>`,
                attachments: [
                    {
                        filename: `${vin}.pdf`,
                        content: pdfBuffer.toString('base64'),
                        type: 'application/pdf',
                    }
                ]
            });

            console.log(`PDF report (fresh) sent to ${customerEmail}`);
        } catch (error) {
            console.error('Error handling webhook:', error.message);
        }
    }

    res.status(200).send('Webhook received');
});

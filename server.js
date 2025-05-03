const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Carsimulcast API credentials
const API_KEY = 'YCGRDKUUHZTSPYMKDUJVZYUOCRFVMG';
const API_SECRET = 'o83nlvtcpwy4ajae0i17d399xgheb5iwrmzd68bm';

// Test route for root
app.get('/', (req, res) => {
  res.send('Autovyn backend running!');
});

// Vehicle info route
app.get('/vehicle-info/:vin', async (req, res) => {
  const vin = req.params.vin;

  try {
    const response = await axios.get(`https://connect.carsimulcast.com/checkrecords/${vin}`, {
      headers: {
        "API-KEY": API_KEY,
        "API-SECRET": API_SECRET,
      },
    });

    const data = response.data;

    // Check if make, model, year exists
    if (data.make && data.model && data.year) {
      res.json({
        success: true,
        vin: vin,
        make: data.make,
        model: data.model,
        year: data.year
      });
    } else {
      // No vehicle data → invalid VIN or not found
      res.json({
        success: false,
        message: "VIN not found or no vehicle information available."
      });
    }

  } catch (error) {
    console.error(error.response ? error.response.data : error.message);
    res.status(500).json({ success: false, message: 'Server error fetching vehicle info.' });
  }
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

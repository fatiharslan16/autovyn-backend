<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Your Report - Autovyn</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gray-100 text-gray-800 font-sans">
  <div class="min-h-screen flex flex-col items-center justify-center px-4">
    <div class="max-w-xl w-full bg-white p-8 rounded-lg shadow-md text-center">
      <h1 class="text-2xl font-bold mb-4">Your Vehicle Report is Ready</h1>

      <p id="emailInfo" class="text-xl font-semibold text-gray-800 mb-4"></p>

      <p class="text-gray-600 mb-6">Click below to view or download your report.</p>

      <a id="downloadLink" href="#" target="_blank" class="w-full block bg-blue-600 text-white py-3 rounded hover:bg-blue-700 transition">
        Download Report
      </a>
    </div>
  </div>

  <script>
    const urlParams = new URLSearchParams(window.location.search);
    const vin = urlParams.get('vin');
    const email = urlParams.get('email');

    const emailInfo = document.getElementById("emailInfo");
    const downloadLink = document.getElementById("downloadLink");

    if (email) {
      emailInfo.innerText = `Your report has been sent to ${email}`;
    }

    if (vin && email) {
      downloadLink.href = `https://autovyn-backend.onrender.com/report/${vin}?email=${email}`;
    } else if (vin) {
      downloadLink.href = `https://autovyn-backend.onrender.com/report/${vin}`;
    } else {
      document.querySelector("div").innerHTML = "<p class='text-red-500 text-center'>VIN missing. Please contact support.</p>";
    }
  </script>
</body>
</html>

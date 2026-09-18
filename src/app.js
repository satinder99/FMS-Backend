// app.js
const express = require('express');
const pool = require('./config/dbconfig_test'); // Import the database pool

const app = express();
app.use(express.json());

// Example API endpoint fetching data from Postgres
app.get('/users', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM user_accounts');
    res.json(result.rows);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});


app.listen(3000, () => {
  console.log('Server is running on port 3000');
});

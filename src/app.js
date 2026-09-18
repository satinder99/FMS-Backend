// app-wiring-example.js — NOT a real entry point, just shows how the
// pieces above plug into your existing Express app.

const express = require('express');
const cookieParser = require('cookie-parser'); // needed to read the refresh-token cookie
const authRoutes = require('./Auth/authRoutes');
const { requireAuth } = require('./Auth/authMiddleware');
const errorHandler = require('./Errors/errorHandles');

const app = express();
app.use(express.json());
app.use(cookieParser());

app.get('/', async (req, res) => {
  try {
    
    res.json(`Home page`);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

app.use('/api/auth', authRoutes);
// -> POST /api/auth/signup
// -> POST /api/auth/signin
// -> POST /api/auth/refresh
// -> POST /api/auth/logout
// -> POST /api/auth/logout-all   (revoke everywhere — e.g. on termination)

// Everything else requires a valid short-lived access token:
app.use('/api/orders', requireAuth, /* ordersRouter */ (req, res) => res.send('orders route'));
app.use('/api/drivers', requireAuth, /* driversRouter */ (req, res) => res.send('drivers route'));

app.use(errorHandler); // must be registered LAST

app.listen(3000, () => {
  console.log('Server is running on port 3000');
});
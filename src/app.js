// [BACKEND · Express] src/app.js
require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser'); // needed to read the refresh-token cookie
const cors = require('cors');
const authRoutes = require('./Router/authRoutes');
const adminRoutes = require('./Router/adminRoutes');
const driverRoutes = require('./Router/driverRoutes');
const dispatcherRoutes = require('./Router/dispatcherRoutes');
const errorHandler = require('./Errors/errorHandles');
const { AppError } = require('./Errors/errors');

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(cors({ origin: process.env.CLIENT_ORIGIN || 'http://localhost:5173', credentials: true }));

app.get('/', (req, res) => {
  res.json('Home page');
});

app.use('/api/auth', authRoutes);
// -> POST /api/auth/signup | signin | refresh | logout | logout-all | assign | generate-username

// Business routes. Each router applies requireAuth -> loadContext -> role check itself.
app.use('/api/admin', adminRoutes);
app.use('/api/driver', driverRoutes);
app.use('/api/dispatcher', dispatcherRoutes);

// Unknown routes get a JSON error, not Express's default HTML page. The frontend's
// request() calls res.json(), so an HTML 404 would show up as "Unexpected token <".
app.use((req, res, next) => next(new AppError('Route not found.', 404, 'NOT_FOUND')));

app.use(errorHandler); // must be registered LAST

app.listen(3000, () => {
  console.log('Server is running on port 3000');
});

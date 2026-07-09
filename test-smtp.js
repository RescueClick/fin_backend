import nodemailer from 'nodemailer';
import 'dotenv/config';

const primaryConfig = {
  host: "smtp.hostinger.com",
  port: 587,
  secure: false, // Use TLS
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
  requireTLS: true,
};

async function testMail() {
  console.log('Testing with user:', process.env.EMAIL_USER, 'pass:', process.env.EMAIL_PASS);
  try {
    const transporter = nodemailer.createTransport(primaryConfig);
    await transporter.verify();
    console.log('Server is ready to take our messages (port 587)');
  } catch (error) {
    console.error('Error verifying on port 587:', error);
  }
}

testMail();

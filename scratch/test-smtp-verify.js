import nodemailer from "nodemailer";
import dotenv from "dotenv";
dotenv.config();

const testSmtp = async (host, port, secure) => {
    console.log(`\nTesting ${host}:${port} (secure: ${secure})...`);
    const transporter = nodemailer.createTransport({
        host,
        port,
        secure,
        auth: {
            user: process.env.EMAIL_USER.trim(),
            pass: process.env.EMAIL_PASS.trim(),
        },
        timeout: 10000,
    });

    try {
        await transporter.verify();
        console.log(`✅ ${host}:${port} verified successfully!`);
    } catch (err) {
        console.error(`❌ ${host}:${port} failed: ${err.message}`);
    }
};

const run = async () => {
    await testSmtp("smtp.hostinger.com", 587, false);
    await testSmtp("smtp.hostinger.com", 465, true);
    await testSmtp("smtp.titan.email", 587, false);
    await testSmtp("smtp.titan.email", 465, true);
};

run();

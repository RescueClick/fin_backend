import nodemailer from "nodemailer";

export const sendMail = async ({ to, subject, html }) => {
  // Validate required parameters
  if (!to || !subject || !html) {
    throw new Error("sendMail: Missing required parameters (to, subject, html)");
  }

  // Validate email credentials
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    throw new Error("Email credentials are missing. EMAIL_USER and EMAIL_PASS must be set.");
  }

  // Primary config: Port 587 (TLS) - Known to work based on test
  const primaryConfig = {
    host: "smtp.hostinger.com",
    port: 587,
    secure: false, // Use TLS
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
    requireTLS: true,
    connectionTimeout: 30000, // 30 seconds (increased for slow connections)
    greetingTimeout: 30000,
    socketTimeout: 30000,
  };

  // Fallback config: Port 465 (SSL)
  const fallbackConfig = {
    host: "smtp.hostinger.com",
    port: 465,
    secure: true, // Use SSL
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
    connectionTimeout: 30000, // 30 seconds (increased for slow connections)
    greetingTimeout: 30000,
    socketTimeout: 30000,
  };

  // Try primary config first (port 587 - known to work)
  try {
    const transporter = nodemailer.createTransport(primaryConfig);

    const info = await transporter.sendMail({
      from: `"Trustline Fintech" <${process.env.EMAIL_USER}>`,
      to,
      subject,
      html,
    });

    console.log(`✅ Email sent successfully to ${to} via port 587 (TLS) - Message ID: ${info.messageId}`);
    return info;
  } catch (primaryError) {
    console.warn(`⚠️ Primary SMTP (port 587) failed:`, primaryError.message);
    
    // Try fallback for timeout, auth errors, or connection issues
    if (primaryError.message.includes("authentication") || 
        primaryError.message.includes("535") || 
        primaryError.message.includes("ECONNREFUSED") ||
        primaryError.message.includes("Timeout") ||
        primaryError.code === 'ETIMEDOUT' ||
        primaryError.code === 'ECONNRESET') {
      try {
        console.log(`🔄 Trying fallback SMTP (port 465)...`);
        const transporter = nodemailer.createTransport(fallbackConfig);

        const info = await transporter.sendMail({
          from: `"Trustline Fintech" <${process.env.EMAIL_USER}>`,
          to,
          subject,
          html,
        });

        console.log(`✅ Email sent successfully to ${to} via port 465 (SSL) - Message ID: ${info.messageId}`);
        return info;
      } catch (fallbackError) {
        console.error(`❌ Both SMTP configurations failed`);
        console.error(`   Primary (587) error: ${primaryError.message}`);
        console.error(`   Fallback (465) error: ${fallbackError.message}`);
        
        // Enhanced error diagnostics
        if (fallbackError.message.includes("535") || fallbackError.message.includes("authentication")) {
          console.error(`   🔴 Authentication Error:`);
          console.error(`      1. EMAIL_USER should be full email: ${process.env.EMAIL_USER}`);
          console.error(`      2. EMAIL_PASS should be correct (use App Password if 2FA enabled)`);
          console.error(`      3. Verify SMTP is enabled in Hostinger control panel`);
          
          throw new Error(`SMTP Authentication Failed: ${fallbackError.message}`);
        }
        
        throw fallbackError;
      }
    }
    
    // For non-auth errors, throw the primary error
    console.error(`❌ Failed to send email to ${to}:`, primaryError.message);
    throw primaryError;
  }
};

// Comprehensive Email Service for all main workflows
import { sendMail } from "./sendMail.js";
import { COMPANY_NAME, COMPANY_NAME_LEGAL, getClientBaseUrl, SUPPORT_EMAIL } from "../config/branding.js";

/**
 * Email templates and service functions for all main workflows
 */

// Base email template wrapper with professional header and footer
const getEmailTemplate = (title, content, footerText = `${COMPANY_NAME} Team`) => {
  const base = getClientBaseUrl();
  // Brand header (teal mark; replace with hosted logo URL if needed)
  const logoSVG = `
    <svg width="60" height="60" viewBox="0 0 60 60" xmlns="http://www.w3.org/2000/svg">
      <path d="M30 5 L50 5 L50 15 L40 15 L40 50 L35 50 L35 55 L25 55 L25 50 L20 50 L20 15 L10 15 L10 5 Z" 
            fill="#12B99C" stroke="#12B99C" stroke-width="2"/>
      <path d="M35 15 L35 20 L25 20 L25 15 Z" fill="#12B99C"/>
    </svg>
  `;

  // Base64 encoded logo (simplified T logo in teal)
  const logoBase64 = "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNjAiIGhlaWdodD0iNjAiIHZpZXdCb3g9IjAgMCA2MCA2MCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cGF0aCBkPSJNMzAgNSBMNTAgNSBMNTAgMTUgTDQwIDE1IEw0MCA1MCBMMzUgNTAgTDM1IDU1IEwyNSA1NSBMMjUgNTAgTDIwIDUwIEwyMCAxNSBMMTAgMTUgTDEwIDUgWiIgZmlsbD0iIzEyQjk5QyIgc3Ryb2tlPSIjMTJCOTlDIiBzdHJva2Utd2lkdGg9IjIiLz48L3N2Zz4=";

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <style>
        body { 
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; 
          line-height: 1.6; 
          color: #333; 
          margin: 0; 
          padding: 0; 
          background-color: #f5f5f5;
        }
        .email-wrapper { 
          max-width: 600px; 
          margin: 0 auto; 
          background-color: #ffffff;
        }
        .header { 
          background: linear-gradient(135deg, #12B99C 0%, #0d9488 100%); 
          color: white; 
          padding: 24px 20px; 
          text-align: center; 
        }
        .company-name {
          font-size: 24px;
          font-weight: bold;
          margin: 0 0 4px;
          letter-spacing: 0.5px;
        }
        .company-tagline {
          font-size: 13px;
          opacity: 0.95;
          font-weight: 300;
          margin: 0;
        }
        .content { 
          background: #ffffff; 
          padding: 24px 20px; 
        }
        .content-title {
          font-size: 22px;
          font-weight: 600;
          color: #12B99C;
          margin: 0 0 16px;
          text-align: center;
        }
        .info-box { 
          background: #f9fafb; 
          padding: 16px; 
          border-radius: 6px; 
          margin: 16px 0; 
          border-left: 4px solid #12B99C; 
        }
        .info-row { 
          margin: 8px 0; 
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
        }
        .label { 
          font-weight: 600; 
          color: #374151; 
          min-width: 120px;
        }
        .value { 
          color: #111827; 
          flex: 1;
          text-align: right;
        }
        .button { 
          display: inline-block; 
          background: #12B99C; 
          color: white; 
          padding: 12px 24px; 
          text-decoration: none; 
          border-radius: 6px; 
          margin: 16px 0; 
          font-weight: 600;
          font-size: 15px;
          transition: background 0.3s;
        }
        .button:hover {
          background: #0d9488;
        }
        .footer { 
          background: #f9fafb;
          border-top: 1px solid #e5e7eb;
          text-align: center; 
          padding: 20px; 
          color: #6b7280; 
          font-size: 12px; 
        }
        .footer-company {
          font-weight: 600;
          color: #12B99C;
          font-size: 15px;
          margin: 0 0 4px;
        }
        .footer-tagline {
          font-size: 11px;
          color: #9ca3af;
          margin: 0 0 12px;
        }
        .footer-links {
          margin: 12px 0;
          padding: 12px 0;
          border-top: 1px solid #e5e7eb;
          border-bottom: 1px solid #e5e7eb;
        }
        .footer-links a {
          color: #12B99C;
          text-decoration: none;
          margin: 0 10px;
          font-size: 12px;
        }
        .footer-links a:hover {
          text-decoration: underline;
        }
        .footer-contact {
          margin: 12px 0;
          line-height: 1.6;
        }
        .footer-contact-item {
          margin: 3px 0;
        }
        .footer-copyright {
          margin-top: 12px;
          padding-top: 12px;
          border-top: 1px solid #e5e7eb;
          font-size: 11px;
          color: #9ca3af;
        }
        .status-badge { 
          display: inline-block; 
          padding: 5px 12px; 
          border-radius: 20px; 
          font-weight: 600; 
          margin: 8px 0; 
          font-size: 12px;
        }
        .status-active { background: #d1fae5; color: #065f46; }
        .status-pending { background: #fef3c7; color: #92400e; }
        .status-approved { background: #d1fae5; color: #065f46; }
        .status-rejected { background: #fee2e2; color: #991b1b; }
        .status-disbursed { background: #dbeafe; color: #1e40af; }
        .alert { 
          padding: 12px 16px; 
          border-radius: 6px; 
          margin: 16px 0; 
          border-left: 4px solid;
        }
        .alert-success { background: #d1fae5; color: #065f46; border-left-color: #10b981; }
        .alert-warning { background: #fef3c7; color: #92400e; border-left-color: #f59e0b; }
        .alert-error { background: #fee2e2; color: #991b1b; border-left-color: #ef4444; }
        .alert-info { background: #dbeafe; color: #1e40af; border-left-color: #3b82f6; }
        @media only screen and (max-width: 600px) {
          .content { padding: 20px 16px; }
          .header { padding: 20px 16px; }
          .footer { padding: 16px; }
        }
      </style>
    </head>
    <body>
      <div class="email-wrapper">
        <!-- Professional Header -->
        <div class="header">
          <div class="company-name">${COMPANY_NAME}</div>
        </div>

        <!-- Content -->
        <div class="content">
          <div class="content-title">${title}</div>
          ${content}
        </div>

        <!-- Professional Footer -->
        <div class="footer">
          <div class="footer-company">${COMPANY_NAME_LEGAL}</div>
          <div class="footer-tagline">Your Trusted Financial Partner</div>
          
          <div class="footer-links">
            <a href="${base}">Website</a>
            <a href="${base}/contact">Contact Us</a>
            <a href="${base}/privacy">Privacy Policy</a>
            <a href="${base}/terms">Terms & Conditions</a>
          </div>

          <div class="footer-contact">
            <div class="footer-contact-item">
              <strong>Email:</strong> ${SUPPORT_EMAIL}
            </div>
            <div class="footer-contact-item">
              <strong>Phone:</strong> +91 7057772026
            </div>
            <div class="footer-contact-item">
              <strong>Address:</strong> ${COMPANY_NAME_LEGAL}, India
            </div>
          </div>

          <div class="footer-copyright">
            <p>This is an automated email. Please do not reply to this message.</p>
            <p>&copy; ${new Date().getFullYear()} ${COMPANY_NAME_LEGAL}. All rights reserved.</p>
            <p style="margin-top: 12px; margin-bottom: 0;">Regards,<br/><strong>${footerText}</strong></p>
          </div>
        </div>
      </div>
    </body>
    </html>
  `;
};

/**
 * Send partner registration email
 */
export const sendPartnerRegistrationEmail = async (partner, password = null) => {
  const loginUrl = `${getClientBaseUrl()}/login`;
  const activationMessage = partner.status === "ACTIVE" 
    ? "Your account has been activated and is ready to use!"
    : "Your account is pending approval. You will be notified once it's activated.";
  
  const content = `
    <h2>Dear ${partner.firstName} ${partner.lastName},</h2>
    <p>Thank you for registering as a Partner with ${COMPANY_NAME}. ${activationMessage}</p>
    
    <div class="info-box">
      <h3 style="margin-top: 0; color: #12B99C;">Your Account Details</h3>
      <div class="info-row">
        <span class="label">Employee ID:</span>
        <span class="value">${partner.employeeId}</span>
      </div>
      <div class="info-row">
        <span class="label">Partner Code:</span>
        <span class="value">${partner.partnerCode}</span>
      </div>
      <div class="info-row">
        <span class="label">Email:</span>
        <span class="value">${partner.email}</span>
      </div>
      <div class="info-row">
        <span class="label">Account Status:</span>
        <span class="status-badge ${partner.status === "ACTIVE" ? "status-active" : "status-pending"}">${partner.status}</span>
      </div>
      ${password ? `
      <div class="info-row">
        <span class="label">Temporary Password:</span>
        <span class="value"><strong>${password}</strong></span>
      </div>
      <div class="alert alert-warning">
        <strong>⚠️ Important:</strong> Please change your password immediately after first login.
      </div>
      ` : ""}
    </div>
    
    <div style="text-align: center;">
      <a href="${loginUrl}" class="button">Login to Your Account</a>
    </div>
    
    <p style="margin-top: 30px;">If you have any questions or need assistance, please contact our support team.</p>
  `;

  try {
    await sendMail({
      to: partner.email,
      subject: `Welcome to ${COMPANY_NAME} - Partner Registration Successful`,
      html: getEmailTemplate(`Welcome to ${COMPANY_NAME}!`, content),
    });
    console.log("✅ Partner registration email sent to:", partner.email);
    return true;
  } catch (error) {
    console.error("❌ Failed to send partner registration email:", error);
    return false;
  }
};

/**
 * Send loan application created email to customer
 */
export const sendLoanApplicationEmail = async (customer, application, tempPassword = null) => {
  const loginUrl = `${getClientBaseUrl()}/login`;
  
  const content = `
    <h2>Dear ${customer.firstName},</h2>
    <p>Your loan application has been successfully created.</p>
    
    <div class="info-box">
      <h3 style="margin-top: 0; color: #12B99C;">Application Details</h3>
      <div class="info-row">
        <span class="label">Application Number:</span>
        <span class="value">${application.appNo}</span>
      </div>
      <div class="info-row">
        <span class="label">Loan Type:</span>
        <span class="value">${application.loanType}</span>
      </div>
      <div class="info-row">
        <span class="label">Loan Amount:</span>
        <span class="value">₹${application.appliedLoanAmount || application.loanAmount || "N/A"}</span>
      </div>
      <div class="info-row">
        <span class="label">Status:</span>
        <span class="status-badge status-pending">${application.status}</span>
      </div>
    </div>
    
    ${tempPassword ? `
    <div class="info-box">
      <h3 style="margin-top: 0; color: #12B99C;">Login Credentials</h3>
      <div class="info-row">
        <span class="label">Email:</span>
        <span class="value">${customer.email}</span>
      </div>
      <div class="info-row">
        <span class="label">Password:</span>
        <span class="value"><strong>${tempPassword}</strong></span>
      </div>
      <div class="alert alert-warning">
        <strong>⚠️ Important:</strong> Please change your password after first login.
      </div>
    </div>
    ` : ""}
    
    <div style="text-align: center;">
      <a href="${loginUrl}" class="button">View Your Application</a>
    </div>
    
    <p style="margin-top: 30px;">We will keep you updated on the status of your application.</p>
  `;

  try {
    await sendMail({
      to: customer.email,
      subject: `Loan Application Created - ${application.appNo}`,
      html: getEmailTemplate("Loan Application Created", content),
    });
    console.log("✅ Loan application email sent to:", customer.email);
    return true;
  } catch (error) {
    console.error("❌ Failed to send loan application email:", error);
    return false;
  }
};

/**
 * Send application status update email
 */
export const sendApplicationStatusEmail = async (customer, application, oldStatus, newStatus) => {
  const statusMessages = {
    SUBMITTED: "Your application has been submitted and is under review.",
    DOC_INCOMPLETE: "Some documents are missing or need to be updated. Please check and upload the required documents.",
    DOC_COMPLETE: "All required documents have been received and verified.",
    UNDER_REVIEW: "Your application is currently under review by our team.",
    APPROVED: "Congratulations! Your loan application has been approved.",
    AGREEMENT: "Your loan agreement is ready. Please review and sign.",
    REJECTED: "Unfortunately, your loan application has been rejected.",
    DISBURSED: "Your loan has been disbursed successfully.",
  };

  const statusClass = {
    APPROVED: "status-approved",
    DISBURSED: "status-disbursed",
    REJECTED: "status-rejected",
  }[newStatus] || "status-pending";

  const alertClass = {
    APPROVED: "alert-success",
    DISBURSED: "alert-success",
    REJECTED: "alert-error",
  }[newStatus] || "alert-info";

  const content = `
    <h2>Dear ${customer.firstName},</h2>
    <p>Your loan application status has been updated.</p>
    
    <div class="alert ${alertClass}">
      <strong>Status Update:</strong> ${statusMessages[newStatus] || `Your application status has changed from ${oldStatus} to ${newStatus}.`}
    </div>
    
    <div class="info-box">
      <h3 style="margin-top: 0; color: #12B99C;">Application Details</h3>
      <div class="info-row">
        <span class="label">Application Number:</span>
        <span class="value">${application.appNo}</span>
      </div>
      <div class="info-row">
        <span class="label">Loan Type:</span>
        <span class="value">${application.loanType}</span>
      </div>
      <div class="info-row">
        <span class="label">Previous Status:</span>
        <span class="value">${oldStatus}</span>
      </div>
      <div class="info-row">
        <span class="label">Current Status:</span>
        <span class="status-badge ${statusClass}">${newStatus}</span>
      </div>
      ${application.approvedLoanAmount ? `
      <div class="info-row">
        <span class="label">Approved Amount:</span>
        <span class="value">₹${application.approvedLoanAmount}</span>
      </div>
      ` : ""}
    </div>
    
    <div style="text-align: center;">
      <a href="${getClientBaseUrl()}/login" class="button">View Application Details</a>
    </div>
  `;

  try {
    await sendMail({
      to: customer.email,
      subject: `Loan Application Status Update - ${application.appNo}`,
      html: getEmailTemplate("Application Status Update", content),
    });
    console.log("✅ Application status email sent to:", customer.email);
    return true;
  } catch (error) {
    console.error("❌ Failed to send application status email:", error);
    return false;
  }
};

/**
 * Send document status update email
 */
export const sendDocumentStatusEmail = async (customer, application, docType, status) => {
  const statusMessages = {
    VERIFIED: "has been verified and accepted.",
    REJECTED: "has been rejected. Please upload a new document.",
    UPDATED: "needs to be updated. Please upload a new version.",
    PENDING: "is pending verification.",
  };

  const content = `
    <h2>Dear ${customer.firstName},</h2>
    <p>Your document status has been updated.</p>
    
    <div class="info-box">
      <h3 style="margin-top: 0; color: #12B99C;">Document Information</h3>
      <div class="info-row">
        <span class="label">Document Type:</span>
        <span class="value">${docType}</span>
      </div>
      <div class="info-row">
        <span class="label">Status:</span>
        <span class="status-badge ${status === "VERIFIED" ? "status-approved" : status === "REJECTED" ? "status-rejected" : "status-pending"}">${status}</span>
      </div>
      <div class="info-row">
        <span class="label">Application Number:</span>
        <span class="value">${application.appNo}</span>
      </div>
    </div>
    
    <div class="alert ${status === "VERIFIED" ? "alert-success" : status === "REJECTED" ? "alert-error" : "alert-warning"}">
      <strong>${status === "VERIFIED" ? "✓" : status === "REJECTED" ? "✗" : "!"}</strong> 
      Your ${docType} document ${statusMessages[status] || `status is now ${status}.`}
    </div>
    
    ${status === "REJECTED" || status === "UPDATED" ? `
    <div style="text-align: center;">
      <a href="${getClientBaseUrl()}/login" class="button">Upload New Document</a>
    </div>
    ` : ""}
  `;

  try {
    await sendMail({
      to: customer.email,
      subject: `Document Status Update - ${docType}`,
      html: getEmailTemplate("Document Status Update", content),
    });
    console.log("✅ Document status email sent to:", customer.email);
    return true;
  } catch (error) {
    console.error("❌ Failed to send document status email:", error);
    return false;
  }
};

/**
 * Send user account creation email (for RM, ASM, etc.)
 */
export const sendUserAccountEmail = async (user, role, password, createdBy = null) => {
  const roleNames = {
    RM: "Relationship Manager",
    ASM: "Area Sales Manager",
    PARTNER: "Partner",
    ADMIN: "Administrator",
  };

  const content = `
    <h2>Dear ${user.firstName} ${user.lastName},</h2>
    <p>Your ${roleNames[role] || role} account has been successfully created${createdBy ? ` by ${createdBy.firstName} ${createdBy.lastName}` : ""}.</p>
    
    <div class="info-box">
      <h3 style="margin-top: 0; color: #12B99C;">Account Details</h3>
      <div class="info-row">
        <span class="label">Employee ID:</span>
        <span class="value">${user.employeeId || "N/A"}</span>
      </div>
      ${user.rmCode ? `
      <div class="info-row">
        <span class="label">RM Code:</span>
        <span class="value">${user.rmCode}</span>
      </div>
      ` : ""}
      ${user.asmCode ? `
      <div class="info-row">
        <span class="label">ASM Code:</span>
        <span class="value">${user.asmCode}</span>
      </div>
      ` : ""}
      ${user.partnerCode ? `
      <div class="info-row">
        <span class="label">Partner Code:</span>
        <span class="value">${user.partnerCode}</span>
      </div>
      ` : ""}
      <div class="info-row">
        <span class="label">Email:</span>
        <span class="value">${user.email}</span>
      </div>
      <div class="info-row">
        <span class="label">Role:</span>
        <span class="value">${roleNames[role] || role}</span>
      </div>
      ${password ? `
      <div class="info-row">
        <span class="label">Temporary Password:</span>
        <span class="value"><strong>${password}</strong></span>
      </div>
      <div class="alert alert-warning">
        <strong>⚠️ Important:</strong> Please log in and change your password immediately.
      </div>
      ` : ""}
    </div>
    
    <div style="text-align: center;">
      <a href="${getClientBaseUrl()}/login" class="button">Login to Your Account</a>
    </div>
  `;

  try {
    await sendMail({
      to: user.email,
      subject: `Your ${roleNames[role] || role} Account Has Been Created`,
      html: getEmailTemplate("Account Created", content),
    });
    console.log(`✅ ${role} account email sent to:`, user.email);
    return true;
  } catch (error) {
    console.error(`❌ Failed to send ${role} account email:`, error);
    return false;
  }
};

/**
 * Send payout notification email
 */
export const sendPayoutEmail = async (partner, payout) => {
  const content = `
    <h2>Dear ${partner.firstName} ${partner.lastName},</h2>
    <p>Your payout status has been updated.</p>
    
    <div class="info-box">
      <h3 style="margin-top: 0; color: #12B99C;">Payout Details</h3>
      <div class="info-row">
        <span class="label">Payout ID:</span>
        <span class="value">${payout.payoutId || payout._id}</span>
      </div>
      <div class="info-row">
        <span class="label">Amount:</span>
        <span class="value">₹${payout.amount}</span>
      </div>
      <div class="info-row">
        <span class="label">Status:</span>
        <span class="status-badge ${payout.status === "PAID" ? "status-approved" : payout.status === "REJECTED" ? "status-rejected" : "status-pending"}">${payout.status}</span>
      </div>
      ${payout.paymentDate ? `
      <div class="info-row">
        <span class="label">Payment Date:</span>
        <span class="value">${new Date(payout.paymentDate).toLocaleDateString()}</span>
      </div>
      ` : ""}
    </div>
    
    <div style="text-align: center;">
      <a href="${getClientBaseUrl()}/login" class="button">View Payout Details</a>
    </div>
  `;

  try {
    await sendMail({
      to: partner.email,
      subject: `Payout Status Update - ₹${payout.amount}`,
      html: getEmailTemplate("Payout Status Update", content),
    });
    console.log("✅ Payout email sent to:", partner.email);
    return true;
  } catch (error) {
    console.error("❌ Failed to send payout email:", error);
    return false;
  }
};

/**
 * Send incentive paid email
 */
export const sendIncentiveEmail = async (partner, incentive) => {
  const content = `
    <h2>Dear ${partner.firstName} ${partner.lastName},</h2>
    <p>Your incentive status has been updated.</p>
    
    <div class="info-box">
      <h3 style="margin-top: 0; color: #12B99C;">Incentive Details</h3>
      <div class="info-row">
        <span class="label">Incentive ID:</span>
        <span class="value">${incentive.incentiveId || incentive._id}</span>
      </div>
      <div class="info-row">
        <span class="label">Amount:</span>
        <span class="value">₹${Number(incentive.amount || 0).toLocaleString("en-IN")}</span>
      </div>
      <div class="info-row">
        <span class="label">Status:</span>
        <span class="status-badge ${
          incentive.status === "PAID"
            ? "status-approved"
            : incentive.status === "REJECTED"
            ? "status-rejected"
            : "status-pending"
        }">${incentive.status}</span>
      </div>
      ${incentive.month && incentive.year ? `
      <div class="info-row">
        <span class="label">Period:</span>
        <span class="value">${incentive.month}/${incentive.year}</span>
      </div>
      ` : ""}
      ${incentive.paidAt ? `
      <div class="info-row">
        <span class="label">Paid On:</span>
        <span class="value">${new Date(incentive.paidAt).toLocaleDateString()}</span>
      </div>
      ` : ""}
    </div>
    
    <div style="text-align: center;">
      <a href="${getClientBaseUrl()}/login" class="button">View Incentive Details</a>
    </div>
  `;

  try {
    await sendMail({
      to: partner.email,
      subject: `Incentive Status Update - ₹${Number(incentive.amount || 0).toLocaleString("en-IN")}`,
      html: getEmailTemplate("Incentive Status Update", content),
    });
    console.log("✅ Incentive email sent to:", partner.email);
    return true;
  } catch (error) {
    console.error("❌ Failed to send incentive email:", error);
    return false;
  }
};

/**
 * Send password reset email
 */
export const sendPasswordResetEmail = async (user, resetToken, resetUrl) => {
  const content = `
    <h2>Dear ${user.firstName} ${user.lastName},</h2>
    <p>You have requested to reset your password.</p>
    
    <div class="alert alert-info">
      <strong>Reset Link:</strong> Click the button below to reset your password. This link will expire in 1 hour.
    </div>
    
    <div style="text-align: center;">
      <a href="${resetUrl}" class="button">Reset Password</a>
    </div>
    
    <p style="margin-top: 30px; color: #6b7280; font-size: 12px;">
      If you did not request this password reset, please ignore this email or contact support.
    </p>
  `;

  try {
    await sendMail({
      to: user.email,
      subject: `Password Reset Request - ${COMPANY_NAME}`,
      html: getEmailTemplate("Password Reset", content),
    });
    console.log("✅ Password reset email sent to:", user.email);
    return true;
  } catch (error) {
    console.error("❌ Failed to send password reset email:", error);
    return false;
  }
};

/**
 * Send delete account request email to admin / support
 */
export const sendDeleteAccountRequestEmail = async (user, reason = "", source = "WEB") => {
  const adminEmail =
    process.env.SUPPORT_EMAIL ||
    process.env.ADMIN_EMAIL ||
    process.env.EMAIL_USER ||
    SUPPORT_EMAIL;

  const content = `
    <h2>New Delete Account Request</h2>
    <p>A user has requested to delete their account.</p>

    <div class="info-box">
      <h3 style="margin-top: 0; color: #12B99C;">User Details</h3>
      <div class="info-row">
        <span class="label">Name:</span>
        <span class="value">${user.firstName || ""} ${user.lastName || ""}</span>
      </div>
      <div class="info-row">
        <span class="label">Email:</span>
        <span class="value">${user.email}</span>
      </div>
      <div class="info-row">
        <span class="label">Phone:</span>
        <span class="value">${user.phone || "N/A"}</span>
      </div>
      <div class="info-row">
        <span class="label">Role:</span>
        <span class="value">${user.role}</span>
      </div>
      <div class="info-row">
        <span class="label">Employee ID:</span>
        <span class="value">${user.employeeId || "N/A"}</span>
      </div>
      <div class="info-row">
        <span class="label">Requested From:</span>
        <span class="value">${source}</span>
      </div>
    </div>

    ${
      reason
        ? `
    <div class="info-box">
      <h3 style="margin-top: 0; color: #12B99C;">User Reason</h3>
      <p style="white-space: pre-wrap; margin: 0;">${reason}</p>
    </div>
    `
        : ""
    }

    <div class="alert alert-warning">
      <strong>Next Steps:</strong> Please verify the user identity and delete/suspend their account in the admin panel. 
      After completing, send a confirmation email to the user.
    </div>
  `;

  try {
    await sendMail({
      to: adminEmail,
      subject: `Delete Account Request - ${user.email}`,
      html: getEmailTemplate("Delete Account Request", content, `${COMPANY_NAME} Admin`),
    });
    console.log("✅ Delete account request email sent for:", user.email);
    return true;
  } catch (error) {
    console.error("❌ Failed to send delete account request email:", error);
    return false;
  }
};

/**
 * Send confirmation email to user after account deletion
 */
/**
 * Notify partner by email when admin rejects their delete-account request
 */
export const sendDeleteAccountRejectionEmail = async (user) => {
  const content = `
    <h2>Dear ${user.firstName || ""} ${user.lastName || ""},</h2>
    <p>We have reviewed your request to delete your ${COMPANY_NAME} partner account.</p>

    <div class="alert alert-info">
      <strong>Outcome:</strong> Your deletion request was <strong>not approved</strong> at this time. Your partner account remains active and you can continue using the platform as usual.
    </div>

    <div class="info-box">
      <h3 style="margin-top: 0; color: #12B99C;">What this means</h3>
      <p style="margin: 0;">
        No changes were made to your login or account data based on this request. If you still wish to close your account,
        you may submit a new request later or contact our support team with any questions.
      </p>
    </div>

    <p style="margin-top: 24px;">
      If you did not submit this request, please secure your account and contact support immediately.
    </p>
  `;

  try {
    await sendMail({
      to: user.email,
      subject: `Update on your ${COMPANY_NAME} account deletion request`,
      html: getEmailTemplate("Delete Request Not Approved", content),
    });
    console.log("✅ Delete account rejection email sent to:", user.email);
    return true;
  } catch (error) {
    console.error("❌ Failed to send delete account rejection email:", error);
    return false;
  }
};

export const sendDeleteAccountConfirmationEmail = async (user) => {
  const content = `
    <h2>Dear ${user.firstName || ""} ${user.lastName || ""},</h2>
    <p>Your request to delete your ${COMPANY_NAME} account has been processed.</p>

    <div class="info-box">
      <h3 style="margin-top: 0; color: #12B99C;">Account Details</h3>
      <div class="info-row">
        <span class="label">Email:</span>
        <span class="value">${user.email}</span>
      </div>
      <div class="info-row">
        <span class="label">Employee ID:</span>
        <span class="value">${user.employeeId || "N/A"}</span>
      </div>
      <div class="info-row">
        <span class="label">Role:</span>
        <span class="value">${user.role}</span>
      </div>
    </div>

    <div class="alert alert-info">
      <strong>Note:</strong> As per our data retention and regulatory policies, certain transactional records may be retained even after account deletion.
    </div>

    <p style="margin-top: 24px;">
      If you did not request this change or believe this is a mistake, please contact our support team immediately.
    </p>
  `;

  try {
    await sendMail({
      to: user.email,
      subject: `Your ${COMPANY_NAME} Account Has Been Deleted`,
      html: getEmailTemplate("Account Deletion Confirmation", content),
    });
    console.log("✅ Delete account confirmation email sent to:", user.email);
    return true;
  } catch (error) {
    console.error("❌ Failed to send delete account confirmation email:", error);
    return false;
  }
};

/**
 * Send official Commission Payout Invoice & Statement email to partner when Admin settles payout (DONE)
 */
export const sendPartnerPayoutInvoiceEmail = async ({
  partner,
  customerName = "Customer",
  appNo = "APP",
  loanType = "Personal Loan",
  approvedAmount = 0,
  payoutAmount = 0,
  payoutPercentage = 0,
  utrNumber = "",
  note = "",
  bankName = "",
  accountNumber = "",
  ifscCode = "",
}) => {
  if (!partner?.email) {
    console.warn("⚠️ sendPartnerPayoutInvoiceEmail: Partner has no email address.");
    return false;
  }

  const formatINR = (val) =>
    `₹${Number(val || 0).toLocaleString("en-IN", {
      maximumFractionDigits: 2,
      minimumFractionDigits: 2,
    })}`;

  const dateStr = new Date().toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });

  const invoiceNo = `INV-PO-${appNo}-${Date.now().toString().slice(-4)}`;
  const partnerFullName = `${partner.firstName || ""} ${partner.lastName || ""}`.trim() || "Channel Partner";
  const maskedAcc = accountNumber
    ? `XXXX-XXXX-${String(accountNumber).slice(-4)}`
    : "Registered Bank Account";

  const content = `
    <h2>Dear ${partnerFullName},</h2>
    <p style="font-size: 15px; color: #4b5563;">
      We are pleased to inform you that your commission payout for disbursed loan application <strong>#${appNo}</strong> has been successfully processed and transferred to your bank account.
    </p>

    <!-- INVOICE SUMMARY BOX -->
    <div style="background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%); color: white; border-radius: 12px; padding: 20px; margin: 20px 0; box-shadow: 0 4px 12px rgba(0,0,0,0.1);">
      <div style="display: flex; justify-content: space-between; border-bottom: 1px solid rgba(255,255,255,0.15); padding-bottom: 12px; margin-bottom: 15px;">
        <div>
          <span style="font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: #94a3b8; display: block;">Invoice Reference</span>
          <strong style="font-size: 14px; font-family: monospace; color: #38bdf8;">${invoiceNo}</strong>
        </div>
        <div style="text-align: right;">
          <span style="font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: #94a3b8; display: block;">Settlement Date</span>
          <strong style="font-size: 13px; color: #ffffff;">${dateStr}</strong>
        </div>
      </div>

      <div style="margin-bottom: 15px;">
        <span style="font-size: 12px; color: #94a3b8; display: block;">Commission Paid</span>
        <span style="font-size: 28px; font-weight: 900; color: #10b981; letter-spacing: -0.5px;">${formatINR(payoutAmount)}</span>
        ${
          payoutPercentage
            ? `<span style="font-size: 12px; color: #cbd5e1; margin-left: 8px;">(${payoutPercentage}% of loan)</span>`
            : ""
        }
      </div>

      <div style="background: rgba(255,255,255,0.06); border-radius: 8px; padding: 12px; font-size: 12px; line-height: 1.6;">
        <div><strong>Beneficiary Bank:</strong> ${bankName || "Partner Bank"}</div>
        <div><strong>Account Number:</strong> ${maskedAcc}</div>
        ${ifscCode ? `<div><strong>IFSC Code:</strong> ${ifscCode}</div>` : ""}
        ${
          utrNumber
            ? `<div style="margin-top: 6px; color: #38bdf8;"><strong>Bank Reference / UTR:</strong> ${utrNumber}</div>`
            : ""
        }
      </div>
    </div>

    <!-- LOAN & FILE BREAKDOWN TABLE -->
    <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 16px; margin-bottom: 20px;">
      <h3 style="margin-top: 0; margin-bottom: 12px; color: #0f172a; font-size: 14px;">Application & Commission Breakdown</h3>
      <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
        <tr style="border-bottom: 1px solid #e2e8f0;">
          <td style="padding: 8px 0; color: #64748b;">Application No</td>
          <td style="padding: 8px 0; font-weight: bold; text-align: right; color: #0f172a; font-family: monospace;">#${appNo}</td>
        </tr>
        <tr style="border-bottom: 1px solid #e2e8f0;">
          <td style="padding: 8px 0; color: #64748b;">Customer / Borrower</td>
          <td style="padding: 8px 0; font-weight: bold; text-align: right; color: #0f172a;">${customerName}</td>
        </tr>
        <tr style="border-bottom: 1px solid #e2e8f0;">
          <td style="padding: 8px 0; color: #64748b;">Loan Type</td>
          <td style="padding: 8px 0; font-weight: bold; text-align: right; color: #0f172a;">${loanType}</td>
        </tr>
        <tr style="border-bottom: 1px solid #e2e8f0;">
          <td style="padding: 8px 0; color: #64748b;">Approved Disbursal Amount</td>
          <td style="padding: 8px 0; font-weight: bold; text-align: right; color: #0f172a;">${formatINR(approvedAmount)}</td>
        </tr>
        <tr style="border-bottom: 1px solid #e2e8f0;">
          <td style="padding: 8px 0; color: #64748b;">Agreed Commission Rate</td>
          <td style="padding: 8px 0; font-weight: bold; text-align: right; color: #0f172a;">${payoutPercentage ? `${payoutPercentage}%` : "Flat"}</td>
        </tr>
        <tr>
          <td style="padding: 8px 0; color: #0f172a; font-weight: bold; font-size: 14px;">Total Transferred</td>
          <td style="padding: 8px 0; font-weight: 900; text-align: right; color: #059669; font-size: 16px;">${formatINR(payoutAmount)}</td>
        </tr>
      </table>
    </div>

    ${
      note
        ? `<div style="background-color: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 12px; font-size: 13px; color: #166534; margin-bottom: 20px;">
            <strong>Transaction Note:</strong> ${note}
          </div>`
        : ""
    }

    <p style="font-size: 13px; color: #64748b; line-height: 1.6;">
      This email serves as your official Commission Settlement Advice. For any queries regarding this transfer or for TDS certificates, please reach out to our partner accounts team.
    </p>

    <div style="text-align: center; margin-top: 24px; padding-top: 16px; border-top: 1px solid #e2e8f0;">
      <p style="font-size: 12px; color: #94a3b8; margin: 0;">
        Thank you for being a valued Partner with <strong>${COMPANY_NAME}</strong>.
      </p>
    </div>
  `;

  try {
    await sendMail({
      to: partner.email,
      subject: `Commission Payout Invoice - #${appNo} (${formatINR(payoutAmount)}) | ${COMPANY_NAME}`,
      html: getEmailTemplate("Commission Settlement Advice", content),
    });
    console.log(`✅ Commission payout invoice email successfully sent to partner ${partner.email} for app #${appNo}`);
    return true;
  } catch (error) {
    console.error("❌ Failed to send commission payout invoice email:", error);
    return false;
  }
};
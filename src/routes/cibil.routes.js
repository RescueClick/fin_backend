import express from "express";
import { auth } from "../middleware/auth.js";
import { requireRole } from "../middleware/requireRole.js";
import { ROLES } from "../config/roles.js";
import { User } from "../models/User.js";
import { CibilReport } from "../models/CibilReport.js";
import { Payout } from "../models/Payout.js";
import nodemailer from "nodemailer";

// Configure nodemailer transporter
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

const router = express.Router();

/**
 * MOCK RAZORPAY CONFIG
 * In a real environment, you'd use the razorpay SDK here.
 */
const CIBIL_FEE = 100; // Customer pays Rs 100
const PARTNER_COMMISSION = 10; // Partner gets Rs 10

// POST /api/cibil/initiate
// Partner initiates a CIBIL check for a customer. Simulates sending an OTP and creating a payment order.
router.post("/initiate", auth, requireRole(ROLES.PARTNER), async (req, res) => {
  try {
    const { customerPhone, customerPan, customerId } = req.body;
    const partnerId = req.user.sub;

    if (!customerPhone) {
      return res.status(400).json({ message: "Customer phone is required" });
    }

    // Generate a mock Razorpay Order ID
    const mockOrderId = "order_" + Math.random().toString(36).substr(2, 9);

    // Create pending Cibil Report entry
    const report = new CibilReport({
      partnerId,
      customerId: customerId || null,
      customerPhone,
      customerPan,
      razorpayOrderId: mockOrderId,
      paymentStatus: "PENDING",
      status: "INITIATED",
      ipAddress: req.ip,
    });

    await report.save();

    // In a real flow, you'd send an OTP to customerPhone here using an SMS provider.
    return res.json({
      message: "CIBIL check initiated. OTP sent to customer.",
      reportId: report._id,
      razorpayOrderId: mockOrderId,
      amount: CIBIL_FEE,
      // For mock testing purposes, we send a dummy OTP back so the frontend can auto-fill or test.
      mockOtp: "123456" 
    });
  } catch (err) {
    console.error("Error initiating CIBIL check:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
});

// POST /api/cibil/verify
// Verifies OTP and Payment, fetches mock CIBIL data, generates commission.
router.post("/verify", auth, requireRole(ROLES.PARTNER), async (req, res) => {
  try {
    const { reportId, otp, razorpayPaymentId } = req.body;
    const partnerId = req.user.sub;

    if (otp !== "123456") {
      return res.status(400).json({ message: "Invalid OTP" });
    }

    const report = await CibilReport.findOne({ _id: reportId, partnerId });
    if (!report) {
      return res.status(404).json({ message: "CIBIL report request not found" });
    }

    if (report.paymentStatus === "PAID") {
      return res.status(400).json({ message: "Payment already processed for this report." });
    }

    // 1. Mark Payment as Paid
    report.paymentStatus = "PAID";
    report.razorpayPaymentId = razorpayPaymentId || "pay_mock_" + Math.random().toString(36).substr(2, 9);
    report.feeCollected = CIBIL_FEE;
    report.commissionAmount = PARTNER_COMMISSION;

    // 2. Fetch Mock CIBIL Score (Random between 600 and 850)
    const mockScore = Math.floor(Math.random() * (850 - 600 + 1) + 600);
    report.score = mockScore;
    report.status = "SUCCESS";
    const totalAccounts = Math.floor(Math.random() * 5) + 2;
    const activeAccounts = Math.floor(Math.random() * totalAccounts) + 1;
    const currentBalance = Math.floor(Math.random() * 500000) + 10000;
    const overdueAmount = mockScore < 700 ? Math.floor(Math.random() * 50000) + 1000 : 0;
    const paymentHistory = Math.floor(mockScore / 9) + "%";
    
    report.rawReportData = {
      provider: "MockAPI",
      score: mockScore,
      personalDetails: {
        name: "Mock Customer",
        pan: report.customerPan || "ABCDE1234F",
        dob: "01-01-1990",
      },
      accountSummary: {
        totalAccounts,
        activeAccounts,
        closedAccounts: totalAccounts - activeAccounts,
        currentBalance,
        overdueAmount,
      },
      creditFactors: {
        paymentHistory,
        creditUtilization: Math.floor(Math.random() * 60 + 10) + "%",
        creditAge: Math.floor(Math.random() * 8 + 2) + " Years",
        totalEnquiries: Math.floor(Math.random() * 5),
      },
      generatedAt: new Date().toISOString()
    };

    await report.save();

    // 3. Generate Partner Commission (Payout)
    const payout = new Payout({
      cibilReport: report._id,
      type: "CIBIL_COMMISSION",
      partnerId,
      amount: PARTNER_COMMISSION,
      payOutStatus: "PENDING",
      note: `Commission for checking CIBIL of ${report.customerPhone}`
    });
    await payout.save();

    return res.json({
      message: "CIBIL score fetched successfully!",
      report,
      commissionEarned: PARTNER_COMMISSION
    });

  } catch (err) {
    console.error("Error verifying CIBIL check:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
});

// GET /api/cibil/partner/history
// Fetch history for the logged-in partner
router.get("/partner/history", auth, requireRole(ROLES.PARTNER), async (req, res) => {
  try {
    const partnerId = req.user.sub;
    const reports = await CibilReport.find({ partnerId }).sort({ createdAt: -1 });
    return res.json(reports);
  } catch (err) {
    console.error("Error fetching CIBIL history:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
});

// GET /api/cibil/admin/all
// Admin route to fetch all checks for analytics
router.get("/admin/all", auth, requireRole(ROLES.ADMIN), async (req, res) => {
  try {
    const reports = await CibilReport.find()
      .populate("partnerId", "firstName lastName partnerCode email")
      .populate("customerId", "firstName lastName")
      .sort({ createdAt: -1 });
      
    // Calculate simple stats
    let totalCollected = 0;
    let totalCommissions = 0;
    let successfulChecks = 0;

    reports.forEach(r => {
      if (r.status === "SUCCESS") {
        totalCollected += r.feeCollected || 0;
        totalCommissions += r.commissionAmount || 0;
        successfulChecks++;
      }
    });

    // Mock API cost (Rs 30 per successful check)
    const totalApiCost = successfulChecks * 30;
    const netProfit = totalCollected - totalCommissions - totalApiCost;

    return res.json({
      stats: {
        totalChecks: reports.length,
        successfulChecks,
        totalCollected,
        totalCommissions,
        totalApiCost,
        netProfit
      },
      reports
    });
  } catch (err) {
    console.error("Error fetching all CIBIL reports:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
});

export default router;

// POST /api/cibil/report/:id/email
// Sends the detailed CIBIL report via email to the partner
router.post("/report/:id/email", auth, requireRole(ROLES.PARTNER), async (req, res) => {
  try {
    const partnerId = req.user.sub;
    const reportId = req.params.id;

    const report = await CibilReport.findOne({ _id: reportId, partnerId });
    if (!report) {
      return res.status(404).json({ message: "CIBIL report not found." });
    }

    const partner = await User.findById(partnerId);
    if (!partner || !partner.email) {
      return res.status(400).json({ message: "Partner email not found." });
    }

    const rawData = report.rawReportData;
    if (!rawData) {
      return res.status(400).json({ message: "Detailed report data not available." });
    }

    const htmlContent = `
      <div style="font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: 0 auto; border: 1px solid #ddd; border-radius: 8px; overflow: hidden;">
        <div style="background-color: #2563EB; padding: 20px; text-align: center;">
          <h1 style="color: #fff; margin: 0;">Detailed CIBIL Report</h1>
          <p style="color: #E0E7FF; margin-top: 5px;">Report ID: ${report._id}</p>
        </div>
        <div style="padding: 20px;">
          <h2 style="color: #1E293B; border-bottom: 2px solid #E2E8F0; padding-bottom: 5px;">Score Summary</h2>
          <p><strong>CIBIL Score:</strong> <span style="font-size: 24px; color: ${rawData.score >= 750 ? '#10B981' : (rawData.score >= 650 ? '#F59E0B' : '#EF4444')}; font-weight: bold;">${rawData.score}</span> / 900</p>
          <p><strong>Status:</strong> ${rawData.score >= 750 ? 'Excellent' : (rawData.score >= 650 ? 'Fair' : 'Poor')}</p>
          
          <h2 style="color: #1E293B; border-bottom: 2px solid #E2E8F0; padding-bottom: 5px; margin-top: 30px;">Personal Details</h2>
          <p><strong>Name:</strong> ${rawData.personalDetails?.name}</p>
          <p><strong>Mobile:</strong> +91 ${report.customerPhone}</p>
          <p><strong>PAN:</strong> ${rawData.personalDetails?.pan}</p>

          <h2 style="color: #1E293B; border-bottom: 2px solid #E2E8F0; padding-bottom: 5px; margin-top: 30px;">Account Summary</h2>
          <table style="width: 100%; border-collapse: collapse;">
            <tr><td style="padding: 8px 0; border-bottom: 1px solid #F1F5F9;">Total Accounts:</td><td style="text-align: right; font-weight: bold;">${rawData.accountSummary?.totalAccounts}</td></tr>
            <tr><td style="padding: 8px 0; border-bottom: 1px solid #F1F5F9;">Active Accounts:</td><td style="text-align: right; font-weight: bold;">${rawData.accountSummary?.activeAccounts}</td></tr>
            <tr><td style="padding: 8px 0; border-bottom: 1px solid #F1F5F9;">Current Balance:</td><td style="text-align: right; font-weight: bold;">₹${rawData.accountSummary?.currentBalance?.toLocaleString()}</td></tr>
            <tr><td style="padding: 8px 0; border-bottom: 1px solid #F1F5F9; color: #EF4444;">Overdue Amount:</td><td style="text-align: right; font-weight: bold; color: #EF4444;">₹${rawData.accountSummary?.overdueAmount?.toLocaleString()}</td></tr>
          </table>

          <h2 style="color: #1E293B; border-bottom: 2px solid #E2E8F0; padding-bottom: 5px; margin-top: 30px;">Credit Factors</h2>
          <table style="width: 100%; border-collapse: collapse;">
            <tr><td style="padding: 8px 0; border-bottom: 1px solid #F1F5F9;">Payment History:</td><td style="text-align: right; font-weight: bold;">${rawData.creditFactors?.paymentHistory}</td></tr>
            <tr><td style="padding: 8px 0; border-bottom: 1px solid #F1F5F9;">Credit Utilization:</td><td style="text-align: right; font-weight: bold;">${rawData.creditFactors?.creditUtilization}</td></tr>
            <tr><td style="padding: 8px 0; border-bottom: 1px solid #F1F5F9;">Credit Age:</td><td style="text-align: right; font-weight: bold;">${rawData.creditFactors?.creditAge}</td></tr>
            <tr><td style="padding: 8px 0; border-bottom: 1px solid #F1F5F9;">Total Enquiries:</td><td style="text-align: right; font-weight: bold;">${rawData.creditFactors?.totalEnquiries}</td></tr>
          </table>
          
          <p style="margin-top: 40px; text-align: center; color: #64748B; font-size: 12px;">Generated by DhanSource Capital on ${new Date(rawData.generatedAt).toLocaleString()}</p>
        </div>
      </div>
    `;

    await transporter.sendMail({
      from: \`"DhanSource Capital" <\${process.env.EMAIL_USER}>\`,
      to: partner.email,
      subject: \`CIBIL Report - +91 \${report.customerPhone}\`,
      html: htmlContent,
    });

    return res.json({ message: "Report successfully sent to your email!" });

  } catch (err) {
    console.error("Error sending CIBIL email:", err);
    return res.status(500).json({ message: "Failed to send email." });
  }
});

import "dotenv/config.js";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import hpp from "hpp";
import rateLimit from "express-rate-limit";
import morgan from "morgan";
import authRoutes from "./src/routes/auth.routes.js";
import adminRoutes from "./src/routes/admin.routes.js";
import asmRoutes from "./src/routes/asm.routes.js";
import rmRoutes from "./src/routes/rm.routes.js";
import partnerRoutes from "./src/routes/partner.routes.js";
import contactRoutes from "./src/routes/contact.routes.js";
import customerRoutes from "./src/routes/customer.routes.js";
import notificationRoutes from "./src/routes/notification.routes.js";
import { connectDB } from "./src/db/db.js";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import cron from "node-cron";
import { createServer } from "http";
import { Server } from "socket.io";
import { cleanupRejectedApps } from "./src/jobs/cleanupRejectedApps.js";
import { initializeSocket } from "./src/socket/socketHandler.js";
import { Notification } from "./src/models/Notification.js";

dotenv.config();

const requiredEnv = ["MONGO_URI", "JWT_SECRET", "EMAIL_USER", "EMAIL_PASS"];
requiredEnv.forEach((key) => {
  if (!process.env[key]) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
});

const app = express();
const server = createServer(app);

const allowedOrigins = [
  "http://localhost:5173",
  "https://frontend-ifyy.vercel.app",
  "https://trustlinefintech.com",
];

app.use(
  "/uploads",
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
  }),
  express.static(path.join(process.cwd(), "uploads"))
);

// Configure helmet with CSP that allows inline scripts for test-email page
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"], // Allow inline scripts for test page
      scriptSrcAttr: ["'unsafe-inline'"], // Allow inline event handlers
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:"],
    },
  },
}));
app.use(hpp());
app.use(express.json({ limit: "50mb" })); // Increased for file uploads
app.use(express.urlencoded({ extended: true, limit: "50mb" })); // For multipart/form-data
app.use(morgan("tiny"));

// === RATE LIMITER FOR SENSITIVE ENDPOINTS ONLY ===
const authLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 20,
  message: "Too many attempts, try again later",
});

// Apply limiter ONLY on these sensitive routes
app.use("/api/auth/login", authLimiter);
app.use("/api/auth/create-admin", authLimiter);
app.use("/api/auth/reset-password/request", authLimiter);
app.use("/api/auth/reset-password/confirm", authLimiter);
app.use("/api/partner/signup-partner", authLimiter);

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (like mobile apps, Postman, etc.)
      if (!origin) {
        return callback(null, true);
      }
      if (allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        // For development, allow local network IPs (React Native)
        if (origin.includes('10.100.12.2') || origin.includes('192.168.') || origin.includes('localhost')) {
          return callback(null, true);
        }
        callback(new Error("Not allowed by CORS"));
      }
    },
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "Accept"],
    credentials: true,
  })
);

// Get __dirname for ES modules (needed for serving static files)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Serve email test JavaScript file (BEFORE API routes to avoid conflicts)
app.get("/test-email.js", (_, res) => {
  const jsPath = path.join(__dirname, "test-email.js");
  console.log("📄 Serving test-email.js from:", jsPath);
  
  // Set correct MIME type for JavaScript
  res.setHeader('Content-Type', 'application/javascript');
  
  res.sendFile(jsPath, (err) => {
    if (err) {
      console.error("❌ Error serving test-email.js:", err);
      console.error("   File path:", jsPath);
      console.error("   __dirname:", __dirname);
      console.error("   process.cwd():", process.cwd());
      res.status(404).json({ 
        error: "Test email JS not found",
        path: jsPath,
        __dirname: __dirname,
        cwd: process.cwd()
      });
    }
  });
});

// Serve email test HTML page (BEFORE API routes to avoid conflicts)
app.get("/test-email", (_, res) => {
  const htmlPath = path.join(__dirname, "test-email.html");
  console.log("📄 Serving test-email.html from:", htmlPath);
  res.sendFile(htmlPath, (err) => {
    if (err) {
      console.error("❌ Error serving test-email.html:", err);
      res.status(404).json({ 
        error: "Test email page not found", 
        path: htmlPath,
        cwd: process.cwd(),
        __dirname: __dirname
      });
    }
  });
});

app.get("/health", (_, res) => res.json({ status: "ok" }));

// API Routes (registered after static file routes)
app.use("/api/auth", authRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/asm", asmRoutes);
app.use("/api/rm", rmRoutes);
app.use("/api/partner", partnerRoutes);
app.use("/api/customer", customerRoutes);
app.use("/api/contact", contactRoutes);
app.use("/api/notifications", notificationRoutes);

// Public email test endpoint (no auth required for testing)
app.post("/api/test-email", async (req, res) => {
  console.log("📧 Email test request received:", {
    email: req.body.email,
    type: req.body.type,
    role: req.body.role,
    timestamp: new Date().toISOString()
  });
  
  try {
    const { sendMail } = await import("./src/utils/sendMail.js");
    const {
      sendUserAccountEmail,
      sendLoanApplicationEmail,
      sendApplicationStatusEmail,
      sendDocumentStatusEmail,
      sendPartnerRegistrationEmail,
    } = await import("./src/utils/emailService.js");

    const { email, type = "all", role = "CUSTOMER" } = req.body;

    if (!email) {
      return res.status(400).json({ 
        success: false, 
        message: "Email address is required" 
      });
    }

    if (!/^\S+@\S+\.\S+$/.test(email)) {
      return res.status(400).json({ 
        success: false, 
        message: "Invalid email format" 
      });
    }

    const results = {};

    // Test basic email
    if (type === "basic" || type === "all") {
      try {
        await sendMail({
          to: email,
          subject: "🧪 Test Email - Basic SendMail",
          html: `
            <h2>Email Test - Basic SendMail</h2>
            <p>This is a test email to verify basic email sending functionality.</p>
            <p><b>Test Time:</b> ${new Date().toLocaleString()}</p>
            <p><b>Status:</b> ✅ Email service is working!</p>
          `,
        });
        results.basic = { success: true, message: "Basic email sent successfully" };
      } catch (error) {
        results.basic = { success: false, message: error.message };
      }
    }

    // Test role-specific emails
    if (type === "user" || type === "all") {
      const roleData = {
        ADMIN: { code: "ADM-TEST", employeeId: "ADM001" },
        ASM: { asmCode: "ASM-TEST", employeeId: "ASM001" },
        RM: { rmCode: "RM-TEST", employeeId: "RM001" },
        PARTNER: { partnerCode: "PT-TEST", employeeId: "PT001" },
        CUSTOMER: { employeeId: "CUS001" },
      };

      try {
        const testUser = {
          firstName: "Test",
          lastName: role === "CUSTOMER" ? "Customer" : "User",
          email: email,
          ...roleData[role] || roleData.CUSTOMER,
        };
        const emailSent = await sendUserAccountEmail(
          testUser, 
          role, 
          "Test@123",
          { firstName: "System", lastName: "Admin" }
        );
        results.user = { 
          success: emailSent, 
          message: emailSent 
            ? `${role} account email sent successfully` 
            : `Failed to send ${role} account email` 
        };
      } catch (error) {
        results.user = { success: false, message: error.message };
      }
    }

    // Test loan application email
    if (type === "loan" || type === "all") {
      try {
        const testCustomer = { firstName: "Test", email: email };
        const testApplication = {
          appNo: "APP-TEST-001",
          loanType: "HOME_LOAN_SALARIED",
          status: "DRAFT",
          appliedLoanAmount: 500000,
          loanAmount: 500000,
        };
        const emailSent = await sendLoanApplicationEmail(
          testCustomer,
          testApplication,
          "Test@123"
        );
        results.loan = { 
          success: emailSent, 
          message: emailSent 
            ? "Loan application email sent successfully" 
            : "Failed to send loan application email" 
        };
      } catch (error) {
        results.loan = { success: false, message: error.message };
      }
    }

    // Test application status email
    if (type === "status" || type === "all") {
      try {
        const testCustomer = { firstName: "Test", email: email };
        const testApplication = {
          appNo: "APP-TEST-001",
          loanType: "HOME_LOAN_SALARIED",
          status: "APPROVED",
          approvedLoanAmount: 500000,
        };
        const emailSent = await sendApplicationStatusEmail(
          testCustomer,
          testApplication,
          "DRAFT",
          "APPROVED"
        );
        results.status = { 
          success: emailSent, 
          message: emailSent 
            ? "Application status email sent successfully" 
            : "Failed to send application status email" 
        };
      } catch (error) {
        results.status = { success: false, message: error.message };
      }
    }

    // Test document status email
    if (type === "document" || type === "all") {
      try {
        const testCustomer = { firstName: "Test", email: email };
        const testApplication = {
          appNo: "APP-TEST-001",
          loanType: "HOME_LOAN_SALARIED",
        };
        const emailSent = await sendDocumentStatusEmail(
          testCustomer,
          testApplication,
          "AADHAR_FRONT",
          "VERIFIED"
        );
        results.document = { 
          success: emailSent, 
          message: emailSent 
            ? "Document status email sent successfully" 
            : "Failed to send document status email" 
        };
      } catch (error) {
        results.document = { success: false, message: error.message };
      }
    }

    // Test partner registration email
    if (type === "partner" || type === "all") {
      try {
        const testPartner = {
          firstName: "Test",
          lastName: "Partner",
          email: email,
          employeeId: "PT001",
          partnerCode: "PT-TEST",
          status: "ACTIVE",
        };
        const emailSent = await sendPartnerRegistrationEmail(testPartner, "Test@123");
        results.partner = { 
          success: emailSent, 
          message: emailSent 
            ? "Partner registration email sent successfully" 
            : "Failed to send partner registration email" 
        };
      } catch (error) {
        results.partner = { success: false, message: error.message };
      }
    }

    const allSuccess = Object.values(results).every((r) => r.success);
    
    console.log(`✅ Email test completed for ${role}:`, {
      success: allSuccess,
      resultsCount: Object.keys(results).length,
      successCount: Object.values(results).filter(r => r.success).length
    });
    
    res.json({
      success: allSuccess,
      message: allSuccess 
        ? `Email test completed successfully for ${role} role` 
        : `Some email tests failed for ${role} role`,
      results: results,
      testedEmail: email,
      testType: type,
      testedRole: role,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("❌ Email test error:", error);
    console.error("Error stack:", error.stack);
    res.status(500).json({
      success: false,
      message: "Email test failed",
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
    });
  }
});

const PORT = process.env.PORT || 5000;

const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      // Allow requests with no origin (like mobile apps, Postman, etc.)
      if (!origin) {
        return callback(null, true);
      }
      if (allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        // For development, allow local network IPs (React Native)
        if (origin.includes('10.100.12.2') || origin.includes('192.168.') || origin.includes('localhost') || origin.includes('127.0.0.1')) {
          return callback(null, true);
        }
        callback(new Error("Not allowed by CORS"));
      }
    },
    methods: ["GET", "POST"],
    credentials: true,
    allowedHeaders: ["Content-Type", "Authorization", "Accept"],
  },
});

// Initialize socket handlers with authentication and all event handlers
initializeSocket(io);

// Export io for use in routes
export { io };

// Make io available globally for use in route handlers
global.io = io;

connectDB(process.env.MONGO_URI)
  .then(() => {
    server.listen(PORT, () => {
      console.log(`\n${"=".repeat(60)}`);
      console.log(`🚀 API Server Running on Port: ${PORT}`);
      console.log(`${"=".repeat(60)}`);
      console.log(`📧 Email Test Endpoints Available:`);
      console.log(`   🌐 Browser UI: http://localhost:${PORT}/test-email`);
      console.log(`   🔓 Public API: POST http://localhost:${PORT}/api/test-email (No auth required)`);
      console.log(`   🔐 Admin API:  POST http://localhost:${PORT}/api/admin/test-email (Auth required)`);
      console.log(`\n💡 To test emails for ALL user roles (Customer, Partner, RM, ASM, Admin):`);
      console.log(`   curl -X POST http://localhost:${PORT}/api/test-email \\`);
      console.log(`     -H "Content-Type: application/json" \\`);
      console.log(`     -d '{"email": "test@example.com", "type": "all", "role": "CUSTOMER"}'`);
      console.log(`\n📝 Or run: node test-email.js test@example.com all`);
      console.log(`\n👥 Available Roles: CUSTOMER, PARTNER, RM, ASM, ADMIN`);
      console.log(`${"=".repeat(60)}\n`);
    });

    // Schedule daily cleanup for rejected applications
    cron.schedule("0 2 * * *", () => {
      console.log("Running daily cleanup for rejected applications...");
      cleanupRejectedApps();
    });

    // Schedule daily cleanup for old notifications (older than 30 days)
    cron.schedule("0 3 * * *", async () => {
      console.log("Running daily cleanup for old notifications...");
      try {
        await Notification.cleanupOldNotifications(30); // Keep notifications for 30 days
      } catch (error) {
        console.error("Error cleaning up old notifications:", error);
      }
    });
  })
  .catch((e) => {
    console.error("DB connect error:", e);
    process.exit(1);
  });
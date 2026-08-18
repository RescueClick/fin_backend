import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import hpp from "hpp";
import rateLimit from "express-rate-limit";
import morgan from "morgan";
import authRoutes from "./src/routes/auth.routes.js";
import adminRoutes from "./src/routes/admin.routes.js";
import asmRoutes from "./src/routes/asm.routes.js";
import rsmRoutes from "./src/routes/rsm.routes.js";
import rmRoutes from "./src/routes/rm.routes.js";
import partnerRoutes from "./src/routes/partner.routes.js";
import contactRoutes from "./src/routes/contact.routes.js";
import customerRoutes from "./src/routes/customer.routes.js";
import notificationRoutes from "./src/routes/notification.routes.js";
import analyticsRoutes from "./src/routes/analytics.routes.js";
import referralRoutes from "./src/routes/referral.routes.js";
import cibilRoutes from "./src/routes/cibil.routes.js";
import { connectDB } from "./src/db/db.js";
import path from "path";
import { fileURLToPath } from "url";
import cron from "node-cron";
import { createServer } from "http";
import { Server } from "socket.io";
import { cleanupRejectedApps } from "./src/jobs/cleanupRejectedApps.js";
import { initializeSocket } from "./src/socket/socketHandler.js";
import { Notification } from "./src/models/Notification.js";
import { requestContext } from "./src/middleware/requestContext.js";
import { notFound } from "./src/middleware/notFound.js";
import { errorHandler } from "./src/middleware/errorHandler.js";

const requiredEnv = ["MONGO_URI", "JWT_SECRET", "EMAIL_USER", "EMAIL_PASS"];
requiredEnv.forEach((key) => {
  if (!process.env[key]) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
});

const app = express();
const server = createServer(app);

const isProduction = process.env.NODE_ENV === "production";

const allowedOrigins = [
  "https://dhansourcecapital.com",
  "https://www.dhansourcecapital.com",
  "http://localhost:5173",
  "http://localhost:3000",
  "http://localhost:5000",
  "http://localhost:8081",
];

const corsOptions = {
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps, Postman, curl, server-to-server)
    if (!origin) {
      return callback(null, true);
    }
    
    // Check exact matches or any dhansourcecapital.com domain/subdomain
    const isDhanSource = /^https?:\/\/([a-zA-Z0-9-]+\.)*dhansourcecapital\.com(:\d+)?$/.test(origin);
    const isLocalhost = /^https?:\/\/localhost(:\d+)?$/.test(origin) || /^https?:\/\/127\.0\.0\.1(:\d+)?$/.test(origin);
    const isLanIp = /^https?:\/\/(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)/.test(origin);

    if (allowedOrigins.includes(origin) || isDhanSource || isLocalhost || isLanIp) {
      return callback(null, true);
    }

    // Default allow to prevent blocking
    return callback(null, true);
  },
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "Accept", "X-Requested-With", "Origin"],
  credentials: true,
  optionsSuccessStatus: 200,
};

// Mount CORS before ALL other middlewares and routes
app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

app.use(
  "/uploads",
  express.static(path.join(process.cwd(), "uploads"))
);

app.use(requestContext);

// Configure helmet with CSP that allows inline scripts for test-email page
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'", "*"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "*"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "*"],
      imgSrc: ["'self'", "data:", "https:", "*"],
    },
  },
}));
app.use(hpp());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));
app.use(morgan("tiny"));

// === RATE LIMITER FOR SENSITIVE ENDPOINTS ONLY ===
const authLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 50,
  message: "Too many attempts, try again later",
  skip: (req) => req.method === "OPTIONS", // Never rate-limit CORS preflight OPTIONS
});

// Apply limiter ONLY on these sensitive routes
app.use("/api/auth/login", authLimiter);
app.use("/api/auth/google-login", authLimiter);
app.use("/api/auth/create-admin", authLimiter);
app.use("/api/auth/forgot-password", authLimiter);
app.use("/api/auth/verify-otp", authLimiter);
app.use("/api/auth/reset-password", authLimiter);
app.use("/api/auth/reset-password/request", authLimiter);
app.use("/api/auth/reset-password/confirm", authLimiter);
app.use("/api/partner/signup-partner", authLimiter);

// Get __dirname for ES modules (needed for serving static files)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);



// Public referral invite landing page (works before Play Store listing)
app.get("/invite.js", (_, res) => {
  const jsPath = path.join(__dirname, "invite.js");
  res.setHeader("Content-Type", "application/javascript");
  res.sendFile(jsPath, (err) => {
    if (err) {
      res.status(404).json({ error: "Invite JS not found" });
    }
  });
});

app.get("/invite", (_, res) => {
  const htmlPath = path.join(__dirname, "invite.html");
  res.sendFile(htmlPath, (err) => {
    if (err) {
      res.status(404).json({ error: "Invite page not found" });
    }
  });
});

app.get("/health", (_, res) => res.json({ status: "ok" }));

// API Routes (registered after static file routes)
app.use("/api/auth", authRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/asm", asmRoutes);
app.use("/api/rsm", rsmRoutes);
app.use("/api/rm", rmRoutes);
app.use("/api/partner", partnerRoutes);
app.use("/api/customer", customerRoutes);
app.use("/api/contact", contactRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/analytics", analyticsRoutes); // Universal Analytics API
app.use("/api/referral", referralRoutes); // Customer/partner: my referral code, referrals, earnings
app.use("/api/cibil", cibilRoutes); // CIBIL checks and payments



app.use(notFound);
app.use(errorHandler);

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
import { Router } from "express";
import argon2 from "argon2";
import { User } from "../models/User.js";
import { signAccessToken } from "../utils/jwt.js";
import { ROLES } from "../config/roles.js";
import crypto from "crypto";
import { sendMail } from "../utils/sendMail.js";
import { auth } from "../middleware/auth.js";
import { requireRole } from "../middleware/requireRole.js";

const router = Router();

router.post("/create-admin", async (req, res) => {
  try {
    const { firstName, lastName, phone, email, password } = req.body;

    // Check if admin already exists
    const existingAdmin = await User.findOne({ email: email.toLowerCase() });
    if (existingAdmin) {
      return res
        .status(400)
        .json({ message: "Admin already exists with this email" });
    }

    // Hash password with argon2
    const passwordHash = await argon2.hash(password);

    const admin = new User({
      firstName,
      lastName,
      phone,
      email: email.toLowerCase(),
      passwordHash, // ✅ match login field
      role: ROLES.SUPER_ADMIN, // ✅ use constant if defined
      status: "ACTIVE", // ✅ match login query
    });

    await admin.save();

    res.status(201).json({
      message: "Admin created successfully",
      admin: {
        id: admin._id,
        firstName: admin.firstName,
        lastName: admin.lastName,
        phone: admin.phone,
        email: admin.email,
        role: admin.role,
        status: admin.status,
      },
    });
  } catch (error) {
    console.error("Error creating admin:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

/**
 * LOGIN  (Admin, ASM, RM, Partner)
 */
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ message: "email and password required" });
    }

    // Always fetch by email; passwordHash is the stored argon2 hash
    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    // explicitly block suspended users
    if (user.status === "SUSPENDED") {
      return res
        .status(403)
        .json({ message: "Your account has been suspended. Contact admin." });
    }

    // only ACTIVE users can proceed
    if (user.status !== "ACTIVE") {
      return res
        .status(403)
        .json({ message: `Account is not active (status: ${user.status}).` });
    }

    if (!user.passwordHash) {
      return res
        .status(500)
        .json({ message: "Password not set for this account" });
    }

    // verify the argon2 hash with the plain password received
    const ok = await argon2.verify(user.passwordHash, password);
    if (!ok) return res.status(401).json({ message: "Invalid credentials" });

    // issue token
    const token = signAccessToken({
      sub: String(user._id),
      role: user.role,
      rmId: user.rmId ? String(user.rmId) : undefined,
      asmId: user.asmId ? String(user.asmId) : undefined,
    });

    return res.json({
      token,
      user: {
        id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        role: user.role,
        asmCode: user.asmCode,
        status: user.status,
        rmCode: user.rmCode,
        asmId: user.asmId,
        partnerCode: user.partnerCode,
        employeeId: user.employeeId,
      },
    });
  } catch (err) {
    console.error("Login error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
});

// POST /admin/login-as/:userId
router.post(
  "/login-as/:userId",
  auth,
  requireRole(ROLES.SUPER_ADMIN, ROLES.ASM, ROLES.RM),
  async (req, res) => {
    try {
      const { userId } = req.params;
      const currentUserRole = req.user.role;
      const currentUserId = req.user.sub;

      // Find the user to impersonate
      const targetUser = await User.findById(userId);
      if (!targetUser) return res.status(404).json({ message: "User not found" });
      if (targetUser.status !== "ACTIVE")
        return res
          .status(403)
          .json({ message: "Cannot login as inactive user" });

      // Enforce hierarchy: SUPER_ADMIN > ASM > RM > PARTNER
      const roleHierarchy = {
        [ROLES.SUPER_ADMIN]: [ROLES.ASM, ROLES.RM, ROLES.PARTNER, ROLES.CUSTOMER],
        [ROLES.ASM]: [ROLES.RM, ROLES.PARTNER, ROLES.CUSTOMER],
        [ROLES.RM]: [ROLES.PARTNER, ROLES.CUSTOMER],
      };

      const allowedRoles = roleHierarchy[currentUserRole];
      if (!allowedRoles || !allowedRoles.includes(targetUser.role)) {
        return res.status(403).json({ 
          message: `You cannot login as ${targetUser.role}. Only ${allowedRoles?.join(", ") || "none"} roles are allowed.` 
        });
      }

      // Additional hierarchy check: Verify parent-child relationship
      if (currentUserRole === ROLES.ASM) {
        // ASM can only login as their own RMs or RMs' partners
        if (targetUser.role === ROLES.RM && targetUser.asmId?.toString() !== currentUserId) {
          return res.status(403).json({ message: "You can only login as RMs assigned to you" });
        }
        if (targetUser.role === ROLES.PARTNER) {
          const rm = await User.findById(targetUser.rmId);
          if (!rm || rm.asmId?.toString() !== currentUserId) {
            return res.status(403).json({ message: "You can only login as partners under your RMs" });
          }
        }
      } else if (currentUserRole === ROLES.RM) {
        // RM can only login as their own partners
        if (targetUser.role === ROLES.PARTNER && targetUser.rmId?.toString() !== currentUserId) {
          return res.status(403).json({ message: "You can only login as partners assigned to you" });
        }
      }

      // Get current user info for parent tracking
      const currentUser = await User.findById(currentUserId).select("firstName lastName email role");

      // Issue token for the target user with parent info
      const token = signAccessToken({
        sub: String(targetUser._id),
        role: targetUser.role,
        rmId: targetUser.rmId ? String(targetUser.rmId) : undefined,
        asmId: targetUser.asmId ? String(targetUser.asmId) : undefined,
        partnerId: targetUser.partnerId ? String(targetUser.partnerId) : undefined,
        impersonatedBy: currentUserId, // Parent user ID
        parentRole: currentUserRole, // Parent role
      });

      return res.json({
        message: `Logged in as ${targetUser.role} successfully`,
        token,
        user: {
          id: targetUser._id,
          firstName: targetUser.firstName,
          lastName: targetUser.lastName,
          email: targetUser.email,
          role: targetUser.role,
          asmId: targetUser.asmId,
          rmId: targetUser.rmId,
          partnerId: targetUser.partnerId,
          partnerCode: targetUser.partnerCode,
          employeeId: targetUser.employeeId,
        },
        parent: {
          id: currentUser._id,
          firstName: currentUser.firstName,
          lastName: currentUser.lastName,
          email: currentUser.email,
          role: currentUser.role,
        },
      });
    } catch (err) {
      console.error("Admin login-as error:", err);
      res.status(500).json({ message: "Server error" });
    }
  }
);

/**
 * (Optional) Partner self-registration via RM code (referral).
 * Disable this route if you want only RM-created partners.
 */
router.post("/partner/register-by-rmcode", async (req, res) => {
  const { firstName, lastName, email, password, rmCode } = req.body || {};
  if (!firstName || !lastName || !email || !password || !rmCode) {
    return res
      .status(400)
      .json({ message: "name, email, password, rmCode required" });
  }

  const rm = await User.findOne({ rmCode, role: ROLES.RM, status: "ACTIVE" });
  if (!rm) return res.status(400).json({ message: "Invalid RM code" });

  const exists = await User.findOne({ email: email.toLowerCase() });
  if (exists) return res.status(409).json({ message: "Email already in use" });

  const passwordHash = await argon2.hash(password);
  const partner = await User.create({
    firstName,
    lastName,
    email: email.toLowerCase(),
    passwordHash,
    role: ROLES.PARTNER,
    rmId: rm._id,
    partnerCode: `PT-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
  });

  return res.status(201).json({
    message: "Partner registered",
    id: partner._id,
    partnerCode: partner.partnerCode,
  });
});

/**
 * Request password reset (secure version)
 */

router.post("/reset-password/request", async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ message: "Email required" });

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) {
      return res.json({ message: "If an account exists, reset link sent" });
    }

    const resetToken = crypto.randomBytes(32).toString("hex");
    const resetExpiry = Date.now() + 15 * 60 * 1000;

    user.resetToken = resetToken;
    user.resetTokenExpiry = resetExpiry;
    await user.save();

    // Reset link only needs token + email
    const resetLink = `https://trustlinefintech.com/reset-password/confirm?token=${resetToken}&email=${user.email}`;

    // Ensure mailer is configured to prevent 500s on missing env
    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
      console.error(
        "Reset request: email credentials are missing. Skipping email send."
      );
      return res.status(500).json({
        message:
          "Email service not configured. Contact support to complete password reset.",
      });
    }

    try {
      await sendMail({
        to: user.email,
        subject: "Password Reset Request",
        html: `
          <h2>Password Reset</h2>
          <p>Hello ${user.name || "User"},</p>
          <p>Click below to reset your password:</p>
          <a href="${resetLink}">Reset Password</a>
          <p>If you didn’t request this, ignore this email.</p>
        `,
      });
    } catch (mailErr) {
      console.error("Reset request: failed to send email", mailErr);
      return res.status(500).json({
        message:
          "Unable to send reset email right now. Please try again or contact support.",
      });
    }

    return res.json({ message: "If an account exists, reset link sent" });
  } catch (err) {
    console.error("Reset request error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
});

router.post("/reset-password/confirm/:token", async (req, res) => {
  try {
    const { token } = req.params;
    const { email, newPassword, confirmPassword } = req.body;

    if (!token || !email || !newPassword || !confirmPassword) {
      return res.status(400).json({ message: "All fields are required" });
    }

    if (newPassword !== confirmPassword) {
      return res.status(400).json({ message: "Passwords do not match" });
    }

    // Find user by email + token
    const user = await User.findOne({
      email: email.toLowerCase(),
      resetToken: token,
      resetTokenExpiry: { $gt: Date.now() },
    });

    if (!user) {
      return res.status(400).json({ message: "Invalid or expired token" });
    }

    // Backend automatically knows the role here
    console.log("Resetting password for role:", user.role);

    user.passwordHash = await argon2.hash(newPassword);
    user.resetToken = undefined;
    user.resetTokenExpiry = undefined;
    await user.save();

    res.json({ message: "Password reset successful" });
  } catch (err) {
    console.error("Reset confirm error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
});

router.post("/change-password", auth, async (req, res) => {
  try {
    const userId = req.user.sub; // from JWT
    const { oldPassword, newPassword, confirmPassword } = req.body;

    if (!oldPassword || !newPassword || !confirmPassword) {
      return res.status(400).json({ message: "All fields are required" });
    }

    if (newPassword !== confirmPassword) {
      return res.status(400).json({ message: "Passwords do not match" });
    }

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: "User not found" });

    const valid = await argon2.verify(user.passwordHash, oldPassword);
    if (!valid) {
      return res.status(400).json({ message: "Old password is incorrect" });
    }

    // Save new password
    user.passwordHash = await argon2.hash(newPassword);
    await user.save();

    // Send confirmation email
    try {
      await sendMail({
        to: user.email,
        subject: "Your Password Has Been Changed",
        html: `
          <p>Hi ${user.firstName || "User"},</p>
          <p>This is a confirmation that your account password has been successfully changed.</p>
          <p>If you did not make this change, please reset your password immediately or contact our support.</p>
          <br/>
          <p>Regards,<br/>Trustline Fintech Team</p>
        `,
      });
    } catch (mailErr) {
      console.error("⚠️ Password changed but email failed:", mailErr);
      return res.json({
        message: "Password changed successfully, but email failed to send",
      });
    }

    res.json({
      message: "Password changed successfully, confirmation email sent",
    });
  } catch (err) {
    console.error("Change password error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
});

export default router;

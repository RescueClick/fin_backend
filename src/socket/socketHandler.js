import jwt from "jsonwebtoken";
import { User } from "../models/User.js";
import { Application } from "../models/Application.js";
import { getReportingLineFromRmId } from "../utils/reportingLine.js";

// Store active users: { userId: { socketId, role, ... } }
const activeUsers = new Map();

// Socket authentication middleware
export const authenticateSocket = async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token || socket.handshake.headers?.authorization?.replace("Bearer ", "");
    
    if (!token) {
      console.error("❌ Socket auth failed: No token provided", {
        hasAuth: !!socket.handshake.auth,
        hasHeaders: !!socket.handshake.headers,
        authKeys: socket.handshake.auth ? Object.keys(socket.handshake.auth) : [],
      });
      return next(new Error("Authentication error: No token provided"));
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.sub).select("-passwordHash");
    
    if (!user) {
      console.error("❌ Socket auth failed: User not found", { userId: decoded.sub });
      return next(new Error("Authentication error: User not found"));
    }

    socket.userId = user._id.toString();
    socket.userRole = user.role;
    socket.userData = {
      _id: user._id,
      role: user.role,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      employeeId: user.employeeId,
    };

    console.log("✅ Socket authenticated:", {
      userId: socket.userId,
      role: socket.userRole,
      email: user.email,
    });

    next();
  } catch (error) {
    console.error("❌ Socket auth error:", error.message, {
      errorType: error.name,
      hasToken: !!socket.handshake.auth?.token,
    });
    if (error.name === "JsonWebTokenError" || error.name === "TokenExpiredError") {
      next(new Error(`Authentication error: ${error.message}`));
    } else {
      next(new Error("Authentication error: Invalid token"));
    }
  }
};

// Initialize socket handlers
export const initializeSocket = (io) => {
  // Apply authentication middleware
  io.use(authenticateSocket);

  io.on("connection", async (socket) => {
    const userId = socket.userId;
    const role = socket.userRole;
    const userData = socket.userData;

    console.log(`✅ User connected: ${userData.firstName} ${userData.lastName} (${role}) - Socket ID: ${socket.id} - User ID: ${userId}`);

    // Store active user
    activeUsers.set(userId, {
      socketId: socket.id,
      role,
      userData,
      connectedAt: new Date(),
    });

    // Join role-based room
    socket.join(role);
    socket.join(`user_${userId.toString()}`);
    console.log(`📥 User ${userId} (${role}) joined rooms: ${role}, user_${userId.toString()}`);

    // Join specific rooms based on role - COMPREHENSIVE ROLE MANAGEMENT
    if (role === "RM") {
      socket.join(`rm_${userId.toString()}`);
      socket.join("rm"); // Join general RM room for broadcast notifications
      console.log(`📥 RM ${userId} joined rooms: rm_${userId.toString()}, rm`);
    } else if (role === "ASM") {
      socket.join(`asm_${userId.toString()}`);
      socket.join("asm"); // Join general ASM room
      console.log(`📥 ASM ${userId} joined rooms: asm_${userId.toString()}, asm`);
    } else if (role === "RSM") {
      socket.join(`rsm_${userId.toString()}`);
      socket.join("rsm");
      console.log(`📥 RSM ${userId} joined rooms: rsm_${userId.toString()}, rsm`);
    } else if (role === "PARTNER") {
      socket.join(`partner_${userId.toString()}`);
      socket.join("partner"); // Join general partner room
      console.log(`📥 Partner ${userId} joined rooms: partner_${userId.toString()}, partner`);
    } else if (role === "SUPER_ADMIN" || role === "ADMIN") {
      socket.join("admin");
      socket.join("super_admin"); // Join super admin room for SUPER_ADMIN
      if (role === "SUPER_ADMIN") {
        socket.join("super_admin");
      }
      console.log(`📥 ${role} ${userId} joined room: admin${role === "SUPER_ADMIN" ? ", super_admin" : ""}`);
    } else if (role === "CUSTOMER") {
      socket.join("customer"); // Join general customer room
      console.log(`📥 Customer ${userId} joined rooms: user_${userId.toString()}, customer`);
    }
    
    // Log all rooms user is in
    const rooms = Array.from(socket.rooms);
    console.log(`📋 User ${userId} (${role}) is in ${rooms.length} rooms:`, rooms);
    
    // Emit confirmation to client
    socket.emit("authenticated", {
      userId,
      role,
      rooms: rooms,
      message: "Socket authenticated and rooms joined successfully"
    });

    // Emit user online status to relevant users
    io.to(role).emit("userOnline", {
      userId,
      userData,
      timestamp: new Date(),
    });

    // ========== APPLICATION EVENTS ==========
    
    // Application status changed
    socket.on("applicationStatusChanged", async ({ applicationId, newStatus, oldStatus }) => {
      try {
        const application = await Application.findById(applicationId)
          .populate("partnerId", "firstName lastName email")
          .populate("customerId", "firstName lastName email");

        if (!application) return;

        // Notify partner
        if (application.partnerId) {
          io.to(`partner_${application.partnerId._id}`).emit("applicationUpdated", {
            applicationId,
            status: newStatus,
            oldStatus,
            application: {
              _id: application._id,
              status: application.status,
              loanType: application.loanType,
              loanAmount: application.loanAmount,
            },
            timestamp: new Date(),
          });
        }

        // Notify customer
        if (application.customerId) {
          io.to(`user_${application.customerId._id}`).emit("applicationUpdated", {
            applicationId,
            status: newStatus,
            oldStatus,
            application: {
              _id: application._id,
              status: application.status,
              loanType: application.loanType,
              loanAmount: application.loanAmount,
            },
            timestamp: new Date(),
          });
        }

        // Notify RM if assigned
        if (application.rmId) {
          const rmIdStr = String(application.rmId);
          io.to(`rm_${rmIdStr}`).emit("applicationUpdated", {
            applicationId,
            status: newStatus,
            oldStatus,
            application,
            timestamp: new Date(),
          });
          try {
            const line = await getReportingLineFromRmId(rmIdStr);
            const payload = {
              applicationId,
              status: newStatus,
              oldStatus,
              application: {
                _id: application._id,
                status: application.status,
                loanType: application.loanType,
                loanAmount: application.loanAmount,
              },
              timestamp: new Date(),
            };
            if (line.asmId) {
              io.to(`asm_${line.asmId}`).emit("applicationUpdated", payload);
            }
            const rsmSet = new Set(line.rsmIds);
            const appLean = await Application.findById(applicationId).select("rsmId").lean();
            if (appLean?.rsmId) rsmSet.add(String(appLean.rsmId));
            for (const rsmId of rsmSet) {
              io.to(`rsm_${rsmId}`).emit("applicationUpdated", payload);
            }
          } catch (e) {
            console.error("applicationStatusChanged reporting line:", e);
          }
        }

        // Notify Admin
        io.to("admin").emit("applicationUpdated", {
          applicationId,
          status: newStatus,
          oldStatus,
          application,
          timestamp: new Date(),
        });
        io.to("super_admin").emit("applicationUpdated", {
          applicationId,
          status: newStatus,
          oldStatus,
          application,
          timestamp: new Date(),
        });
      } catch (error) {
        console.error("Error handling applicationStatusChanged:", error);
      }
    });

    // New application created
    socket.on("newApplication", async ({ applicationId }) => {
      try {
        const application = await Application.findById(applicationId)
          .populate("partnerId", "firstName lastName")
          .populate("customerId", "firstName lastName")
          .populate("rmId", "firstName lastName");

        if (!application) return;

        // Notify RM
        if (application.rmId) {
          const rmRef = application.rmId._id || application.rmId;
          io.to(`rm_${rmRef}`).emit("newApplication", {
            application,
            timestamp: new Date(),
          });
          try {
            const line = await getReportingLineFromRmId(String(rmRef));
            if (line.asmId) {
              io.to(`asm_${line.asmId}`).emit("newApplication", {
                application,
                timestamp: new Date(),
              });
            }
            for (const rsmId of line.rsmIds) {
              io.to(`rsm_${rsmId}`).emit("newApplication", {
                application,
                timestamp: new Date(),
              });
            }
          } catch (e) {
            console.error("newApplication reporting line:", e);
          }
        }

        // Notify Admin
        io.to("admin").emit("newApplication", {
          application,
          timestamp: new Date(),
        });
        io.to("super_admin").emit("newApplication", {
          application,
          timestamp: new Date(),
        });
      } catch (error) {
        console.error("Error handling newApplication:", error);
      }
    });

    // ========== DOCUMENT EVENTS ==========

    // Document uploaded
    socket.on("documentUploaded", async ({ applicationId, docType, partnerId, customerId }) => {
      try {
        // Notify RM
        const application = await Application.findById(applicationId).populate("rmId");
        if (application?.rmId) {
          io.to(`rm_${application.rmId._id}`).emit("documentUploaded", {
            applicationId,
            docType,
            partnerId,
            customerId,
            timestamp: new Date(),
          });
        }

        const payload = {
          applicationId,
          docType,
          partnerId,
          customerId,
          timestamp: new Date(),
        };
        if (application?.rmId) {
          try {
            const line = await getReportingLineFromRmId(String(application.rmId._id || application.rmId));
            if (line.asmId) io.to(`asm_${line.asmId}`).emit("documentUploaded", payload);
            for (const rsmId of line.rsmIds) {
              io.to(`rsm_${rsmId}`).emit("documentUploaded", payload);
            }
          } catch (e) {
            console.error("documentUploaded reporting line:", e);
          }
        }

        io.to("admin").emit("documentUploaded", payload);
        io.to("super_admin").emit("documentUploaded", payload);
      } catch (error) {
        console.error("Error handling documentUploaded:", error);
      }
    });

    // Document status changed
    socket.on("documentStatusChanged", async ({ applicationId, docType, status, updatedBy }) => {
      try {
        const application = await Application.findById(applicationId)
          .populate("partnerId")
          .populate("customerId");

        // Notify partner
        if (application?.partnerId) {
          io.to(`partner_${application.partnerId._id}`).emit("documentStatusChanged", {
            applicationId,
            docType,
            status,
            updatedBy,
            timestamp: new Date(),
          });
        }

        // Notify customer
        if (application?.customerId) {
          io.to(`user_${application.customerId._id}`).emit("documentStatusChanged", {
            applicationId,
            docType,
            status,
            updatedBy,
            timestamp: new Date(),
          });
        }

        const docPayload = {
          applicationId,
          docType,
          status,
          updatedBy,
          timestamp: new Date(),
        };
        if (application?.rmId) {
          const rmR = String(application.rmId._id || application.rmId);
          io.to(`rm_${rmR}`).emit("documentStatusChanged", { ...docPayload });
          try {
            const line = await getReportingLineFromRmId(rmR);
            if (line.asmId) io.to(`asm_${line.asmId}`).emit("documentStatusChanged", { ...docPayload });
            const appLean = await Application.findById(applicationId).select("rsmId").lean();
            const rsmSet = new Set(line.rsmIds);
            if (appLean?.rsmId) rsmSet.add(String(appLean.rsmId));
            for (const rsmId of rsmSet) {
              io.to(`rsm_${rsmId}`).emit("documentStatusChanged", { ...docPayload });
            }
          } catch (e) {
            console.error("documentStatusChanged reporting line:", e);
          }
        }
        io.to("admin").emit("documentStatusChanged", docPayload);
        io.to("super_admin").emit("documentStatusChanged", docPayload);
      } catch (error) {
        console.error("Error handling documentStatusChanged:", error);
      }
    });

    // ========== PARTNER EVENTS ==========

    // Partner status changed
    socket.on("partnerStatusChanged", async ({ partnerId, newStatus, oldStatus }) => {
      try {
        const partner = await User.findById(partnerId);
        if (!partner) return;

        // Notify partner
        io.to(`partner_${partnerId}`).emit("partnerStatusChanged", {
          partnerId,
          status: newStatus,
          oldStatus,
          timestamp: new Date(),
        });

        // Notify RM
        if (partner.rmId) {
          io.to(`rm_${partner.rmId}`).emit("partnerStatusChanged", {
            partnerId,
            partner: {
              _id: partner._id,
              firstName: partner.firstName,
              lastName: partner.lastName,
              status: partner.status,
            },
            status: newStatus,
            oldStatus,
            timestamp: new Date(),
          });
        }

        // Notify Admin
        io.to("admin").emit("partnerStatusChanged", {
          partnerId,
          status: newStatus,
          oldStatus,
          timestamp: new Date(),
        });
        io.to("super_admin").emit("partnerStatusChanged", {
          partnerId,
          status: newStatus,
          oldStatus,
          timestamp: new Date(),
        });

        if (partner.rmId) {
          try {
            const line = await getReportingLineFromRmId(String(partner.rmId));
            const ps = {
              partnerId,
              status: newStatus,
              oldStatus,
              timestamp: new Date(),
            };
            if (line.asmId) io.to(`asm_${line.asmId}`).emit("partnerStatusChanged", ps);
            for (const rsmId of line.rsmIds) {
              io.to(`rsm_${rsmId}`).emit("partnerStatusChanged", ps);
            }
          } catch (e) {
            console.error("partnerStatusChanged reporting line:", e);
          }
        }
      } catch (error) {
        console.error("Error handling partnerStatusChanged:", error);
      }
    });

    // New partner registered
    socket.on("newPartnerRegistered", async ({ partnerId }) => {
      try {
        const partner = await User.findById(partnerId).populate("rmId");
        
        // Notify Admin
        io.to("admin").emit("newPartnerRegistered", {
          partner: {
            _id: partner._id,
            firstName: partner.firstName,
            lastName: partner.lastName,
            email: partner.email,
            status: partner.status,
          },
          timestamp: new Date(),
        });

        // Notify RM if assigned
        if (partner.rmId) {
          const rmRef = partner.rmId._id || partner.rmId;
          io.to(`rm_${rmRef}`).emit("newPartnerRegistered", {
            partner: {
              _id: partner._id,
              firstName: partner.firstName,
              lastName: partner.lastName,
              email: partner.email,
              status: partner.status,
            },
            timestamp: new Date(),
          });
          try {
            const line = await getReportingLineFromRmId(String(rmRef));
            const np = {
              partner: {
                _id: partner._id,
                firstName: partner.firstName,
                lastName: partner.lastName,
                email: partner.email,
                status: partner.status,
              },
              timestamp: new Date(),
            };
            if (line.asmId) io.to(`asm_${line.asmId}`).emit("newPartnerRegistered", np);
            for (const rsmId of line.rsmIds) {
              io.to(`rsm_${rsmId}`).emit("newPartnerRegistered", np);
            }
          } catch (e) {
            console.error("newPartnerRegistered reporting line:", e);
          }
        }
        io.to("super_admin").emit("newPartnerRegistered", {
          partner: {
            _id: partner._id,
            firstName: partner.firstName,
            lastName: partner.lastName,
            email: partner.email,
            status: partner.status,
          },
          timestamp: new Date(),
        });
      } catch (error) {
        console.error("Error handling newPartnerRegistered:", error);
      }
    });

    // ========== CUSTOMER EVENTS ==========

    // New customer registered
    socket.on("newCustomerRegistered", async ({ customerId, partnerId }) => {
      try {
        const customer = await User.findById(customerId).populate("partnerId");
        
        // Notify partner
        if (customer.partnerId) {
          io.to(`partner_${customer.partnerId._id}`).emit("newCustomerRegistered", {
            customer: {
              _id: customer._id,
              firstName: customer.firstName,
              lastName: customer.lastName,
              email: customer.email,
            },
            timestamp: new Date(),
          });
        }

        // Notify RM if partner has RM
        if (customer.partnerId?.rmId) {
          const rmR = String(customer.partnerId.rmId);
          io.to(`rm_${rmR}`).emit("newCustomerRegistered", {
            customer: {
              _id: customer._id,
              firstName: customer.firstName,
              lastName: customer.lastName,
              email: customer.email,
            },
            timestamp: new Date(),
          });
          try {
            const line = await getReportingLineFromRmId(rmR);
            const nc = {
              customer: {
                _id: customer._id,
                firstName: customer.firstName,
                lastName: customer.lastName,
                email: customer.email,
              },
              timestamp: new Date(),
            };
            if (line.asmId) io.to(`asm_${line.asmId}`).emit("newCustomerRegistered", nc);
            for (const rsmId of line.rsmIds) {
              io.to(`rsm_${rsmId}`).emit("newCustomerRegistered", nc);
            }
          } catch (e) {
            console.error("newCustomerRegistered reporting line:", e);
          }
        }
        io.to("admin").emit("newCustomerRegistered", {
          customer: {
            _id: customer._id,
            firstName: customer.firstName,
            lastName: customer.lastName,
            email: customer.email,
          },
          partnerId: customer.partnerId?._id,
          timestamp: new Date(),
        });
        io.to("super_admin").emit("newCustomerRegistered", {
          customer: {
            _id: customer._id,
            firstName: customer.firstName,
            lastName: customer.lastName,
            email: customer.email,
          },
          partnerId: customer.partnerId?._id,
          timestamp: new Date(),
        });
      } catch (error) {
        console.error("Error handling newCustomerRegistered:", error);
      }
    });

    // ========== PAYOUT EVENTS ==========

    // Payout status changed
    socket.on("payoutStatusChanged", async ({ payoutId, status, partnerId }) => {
      try {
        // Notify partner
        if (partnerId) {
          io.to(`partner_${partnerId}`).emit("payoutStatusChanged", {
            payoutId,
            status,
            timestamp: new Date(),
          });
        }

        const po = { payoutId, status, partnerId, timestamp: new Date() };
        io.to("admin").emit("payoutStatusChanged", po);
        io.to("super_admin").emit("payoutStatusChanged", po);

        if (partnerId) {
          try {
            const partnerUser = await User.findById(partnerId).select("rmId").lean();
            if (partnerUser?.rmId) {
              const rmP = String(partnerUser.rmId);
              const line = await getReportingLineFromRmId(rmP);
              io.to(`rm_${rmP}`).emit("payoutStatusChanged", po);
              if (line.asmId) io.to(`asm_${line.asmId}`).emit("payoutStatusChanged", po);
              for (const rsmId of line.rsmIds) {
                io.to(`rsm_${rsmId}`).emit("payoutStatusChanged", po);
              }
            }
          } catch (e) {
            console.error("payoutStatusChanged reporting line:", e);
          }
        }
      } catch (error) {
        console.error("Error handling payoutStatusChanged:", error);
      }
    });

    // ========== TARGET EVENTS ==========

    // Target assigned/updated
    socket.on("targetUpdated", async ({ targetId, assignedTo, role }) => {
      try {
        // Notify assigned user
        if (role === "PARTNER") {
          io.to(`partner_${assignedTo}`).emit("targetUpdated", {
            targetId,
            timestamp: new Date(),
          });
        } else if (role === "RM") {
          io.to(`rm_${assignedTo}`).emit("targetUpdated", {
            targetId,
            timestamp: new Date(),
          });
        } else if (role === "ASM") {
          io.to(`asm_${assignedTo}`).emit("targetUpdated", {
            targetId,
            timestamp: new Date(),
          });
        } else if (role === "RSM") {
          io.to(`rsm_${assignedTo}`).emit("targetUpdated", {
            targetId,
            timestamp: new Date(),
          });
        }
      } catch (error) {
        console.error("Error handling targetUpdated:", error);
      }
    });

    // ========== NOTIFICATION EVENTS ==========

    // Send notification to user
    socket.on("sendNotification", ({ userId, notification }) => {
      io.to(`user_${userId}`).emit("notification", {
        ...notification,
        timestamp: new Date(),
      });
    });

    // Send notification to role
    socket.on("sendNotificationToRole", ({ role, notification }) => {
      io.to(role).emit("notification", {
        ...notification,
        timestamp: new Date(),
      });
    });

    // ========== DASHBOARD UPDATES ==========

    // Request dashboard update
    socket.on("requestDashboardUpdate", ({ role, userId }) => {
      // This will trigger a dashboard refresh on the client
      if (role === "PARTNER") {
        io.to(`partner_${userId}`).emit("dashboardUpdate", {
          timestamp: new Date(),
        });
      } else if (role === "RM") {
        io.to(`rm_${userId}`).emit("dashboardUpdate", {
          timestamp: new Date(),
        });
      } else if (role === "ASM") {
        io.to(`asm_${userId}`).emit("dashboardUpdate", {
          timestamp: new Date(),
        });
      } else if (role === "RSM") {
        io.to(`rsm_${userId}`).emit("dashboardUpdate", {
          timestamp: new Date(),
        });
      } else if (role === "SUPER_ADMIN" || role === "ADMIN") {
        io.to("admin").emit("dashboardUpdate", {
          timestamp: new Date(),
        });
      }
    });

    // ========== DISCONNECT ==========

    socket.on("disconnect", (reason) => {
      if (userData && userId) {
        console.log(`❌ User disconnected: ${userData.firstName} ${userData.lastName} (${role}) - ${socket.id} - Reason: ${reason}`);
        
        // Remove from active users
        activeUsers.delete(userId);

        // Emit user offline status
        io.to(role).emit("userOffline", {
          userId,
          timestamp: new Date(),
        });
      } else {
        console.log(`❌ Socket disconnected before authentication: ${socket.id} - Reason: ${reason}`);
      }
    });

    // Handle authentication errors
    socket.on("error", (error) => {
      console.error(`❌ Socket error for ${socket.id}:`, error.message);
    });
  });

  return io;
};

// Helper function to emit events from routes
export const emitToUser = (io, userId, event, data) => {
  io.to(`user_${userId}`).emit(event, {
    ...data,
    timestamp: new Date(),
  });
};

export const emitToRole = (io, role, event, data) => {
  io.to(role).emit(event, {
    ...data,
    timestamp: new Date(),
  });
};

export const emitToPartner = (io, partnerId, event, data) => {
  io.to(`partner_${partnerId}`).emit(event, {
    ...data,
    timestamp: new Date(),
  });
};

export const emitToRM = (io, rmId, event, data) => {
  io.to(`rm_${rmId}`).emit(event, {
    ...data,
    timestamp: new Date(),
  });
};

export const emitToASM = (io, asmId, event, data) => {
  io.to(`asm_${asmId}`).emit(event, {
    ...data,
    timestamp: new Date(),
  });
};

export const emitToAdmin = (io, event, data) => {
  io.to("admin").emit(event, {
    ...data,
    timestamp: new Date(),
  });
};

export { activeUsers };

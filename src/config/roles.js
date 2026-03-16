export const ROLES = {
  SUPER_ADMIN: "SUPER_ADMIN",
  ASM: "ASM",
  // New hierarchical role between ASM and RM
  RSM: "RSM",
  RM: "RM",
  PARTNER: "PARTNER",
  CUSTOMER: "CUSTOMER",
};

// Types of RSMs to support split ownership by loan type
export const RSM_TYPES = {
  PERSONAL: "PERSONAL",
  BUSINESS_HOME: "BUSINESS_HOME",
};

export const ALL_ROLES = Object.values(ROLES);

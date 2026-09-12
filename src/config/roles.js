export const ROLES = {
  SUPER_ADMIN: "SUPER_ADMIN",
  ADMIN: "ADMIN",
  RSM: "RSM", // Regional Sales Manager (Senior, directly under Super Admin)
  ASM: "ASM", // Area Sales Manager (Specialized by loan type, under RSM)
  RM: "RM",   // Relationship Manager (under ASMs)
  PARTNER: "PARTNER",
  CUSTOMER: "CUSTOMER",
};

// Types of ASMs to support split ownership by loan type
export const ASM_TYPES = {
  PERSONAL: "PERSONAL",
  BUSINESS: "BUSINESS",
  HOME_LAP: "HOME_LAP",
  BUSINESS_HOME: "BUSINESS_HOME", // Legacy/backward-compatibility alias
};

// Backward-compatibility alias
export const RSM_TYPES = ASM_TYPES;

export const ALL_ROLES = Object.values(ROLES);

/**
 * Data-protection helpers: prefer soft-hide over hard delete.
 * Active UI uses activeApplicationsFilter — records with deletedAt <= now are hidden but kept.
 */

export function softHideTimestamp() {
  return new Date();
}

/** Message when destructive delete is blocked because loan/customer data exists. */
export function dataPreservationBlockMessage(entity = "record") {
  return `Cannot permanently delete this ${entity} while linked applications or customers exist. Reassign or soft-deactivate instead so data is not lost.`;
}

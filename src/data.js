import { Platform } from 'react-native';
import * as local from './database';
import * as remote from './remoteDatabase';

// The browser uses the shared Supabase database so every installed copy of
// Lesachi sees the same customers, rentals, stock and settings. Native builds
// keep the SQLite path for offline operation; they can be switched to the
// same remote store whenever a mobile build is configured with the public key.
export const usesRemoteDatabase = Platform.OS === 'web' && remote.isRemoteConfigured;

function implementation(name, db) {
  return usesRemoteDatabase ? remote[name] : local[name];
}

export function fetchRentals(db) { return implementation('fetchRentals', db)(usesRemoteDatabase ? undefined : db); }
export function fetchEquipmentTypes(db) { return implementation('fetchEquipmentTypes', db)(usesRemoteDatabase ? undefined : db); }
export function createEquipmentType(db, payload) { return implementation('createEquipmentType', db)(usesRemoteDatabase ? payload : db, usesRemoteDatabase ? undefined : payload); }
export function updateEquipmentType(db, id, payload) { return implementation('updateEquipmentType', db)(usesRemoteDatabase ? id : db, usesRemoteDatabase ? payload : id, usesRemoteDatabase ? undefined : payload); }
export function deleteEquipmentType(db, id) { return implementation('deleteEquipmentType', db)(usesRemoteDatabase ? id : db, usesRemoteDatabase ? undefined : id); }
export function createRental(db, payload) { return implementation('createRental', db)(usesRemoteDatabase ? payload : db, usesRemoteDatabase ? undefined : payload); }
export function editRental(db, rentalId, changes) {
  return usesRemoteDatabase
    ? remote.editRental(rentalId, changes)
    : local.editRental(db, rentalId, changes);
}
export function markRentalItemPaid(db, itemId) {
  return usesRemoteDatabase
    ? remote.markRentalItemPaid(itemId)
    : local.markRentalItemPaid(db, itemId);
}
export function recordRentalPayment(db, rentalId, amount, actor = 'Admin') {
  return usesRemoteDatabase
    ? remote.recordRentalPayment(rentalId, amount, actor)
    : local.recordRentalPayment(db, rentalId, amount, actor);
}
export function registerReturn(db, rentalId, returns, legacyQuantity) {
  return usesRemoteDatabase
    ? remote.registerReturn(rentalId, returns, legacyQuantity)
    : local.registerReturn(db, rentalId, returns, legacyQuantity);
}
export function getSetting(db, key) { return implementation('getSetting', db)(usesRemoteDatabase ? key : db, usesRemoteDatabase ? undefined : key); }
export function setSetting(db, key, value) { return usesRemoteDatabase ? remote.setSetting(key, value) : local.setSetting(db, key, value); }
export function logSentMessage(db, rentalId, channel, message, status) {
  return usesRemoteDatabase
    ? remote.logSentMessage(rentalId, channel, message, status)
    : local.logSentMessage(db, rentalId, channel, message, status);
}
export function queueSms(db, payload) {
  return usesRemoteDatabase ? remote.queueSms(payload) : local.queueSms(db, payload);
}
export function fetchSmsQueue(db) {
  return usesRemoteDatabase ? remote.fetchSmsQueue() : local.fetchSmsQueue(db);
}
export function updateSmsQueue(db, id, status, errorMessage) {
  return usesRemoteDatabase ? remote.updateSmsQueue(id, status, errorMessage) : local.updateSmsQueue(db, id, status, errorMessage);
}

export const migrateDatabase = local.migrateDatabase;

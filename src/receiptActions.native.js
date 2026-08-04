import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import * as SMS from 'expo-sms';
import { receiptHtml, receiptSmsText, resolveReceipt } from './utils';

export async function downloadReceiptPdf(rentalOrReceipt, receiptContext) {
  const { rental, type } = resolveReceipt(rentalOrReceipt, receiptContext);
  const { uri } = await Print.printToFileAsync({ html: receiptHtml(rentalOrReceipt, receiptContext) });
  const canShare = await Sharing.isAvailableAsync();
  if (!canShare) return { result: 'saved', uri };
  await Sharing.shareAsync(uri, {
    mimeType: 'application/pdf',
    UTI: 'com.adobe.pdf',
    dialogTitle: `LESA ${type === 'partial' ? 'qisman qaytarish' : type === 'final' ? 'yakuniy' : 'ijara'} chekini saqlash`,
  });
  return { result: 'opened', uri, rentalId: rental.id };
}

export async function printReceipt(rentalOrReceipt, receiptContext) {
  await Print.printAsync({ html: receiptHtml(rentalOrReceipt, receiptContext) });
  return { result: 'opened' };
}

export async function sendReceiptSms(rentalOrReceipt, receiptContext) {
  const { rental } = resolveReceipt(rentalOrReceipt, receiptContext);
  const available = await SMS.isAvailableAsync();
  if (!available) {
    const error = new Error('Bu qurilmada SMS xizmati mavjud emas.');
    error.code = 'SMS_UNAVAILABLE';
    throw error;
  }
  const message = receiptSmsText(rentalOrReceipt, receiptContext);
  const result = await SMS.sendSMSAsync([rental.phone], message);
  return { ...result, message };
}

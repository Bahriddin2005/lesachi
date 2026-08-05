import { jsPDF } from 'jspdf';
import { receiptHtml, receiptSmsText, receiptText, resolveReceipt } from './utils';

function pdfSafeText(text) {
  return text
    .replaceAll('‘', "'")
    .replaceAll('’', "'")
    .replaceAll('×', 'x')
    .replaceAll('—', '-')
    .replaceAll('–', '-');
}

export async function downloadReceiptPdf(rentalOrReceipt, receiptContext) {
  const { rental, type } = resolveReceipt(rentalOrReceipt, receiptContext);
  const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
  pdf.setTextColor(23, 72, 59);
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(22);
  pdf.text('LESA', 18, 20);
  pdf.setTextColor(23, 37, 33);
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(10);
  const lines = pdf.splitTextToSize(pdfSafeText(receiptText(rentalOrReceipt, receiptContext)), 174);
  pdf.text(lines, 18, 32, { lineHeightFactor: 1.55 });
  const suffix = type === 'partial' ? 'qisman-qaytarish' : type === 'final' ? 'yakuniy' : 'ijara';
  pdf.save(`LESA-${suffix}-chek-${String(rental.id || 'chek').slice(-8)}.pdf`);
  return { result: 'downloaded' };
}

export async function printReceipt(rentalOrReceipt, receiptContext) {
  const popup = window.open('', '_blank', 'width=900,height=700');
  if (!popup) throw new Error('Chop etish oynasi bloklandi. Brauzerda pop-up oynalariga ruxsat bering.');
  popup.document.open();
  popup.document.write(receiptHtml(rentalOrReceipt, receiptContext));
  popup.document.close();
  popup.focus();
  window.setTimeout(() => popup.print(), 250);
  return { result: 'opened' };
}

export async function sendReceiptSms(rentalOrReceipt, receiptContext) {
  const { rental } = resolveReceipt(rentalOrReceipt, receiptContext);
  const phone = rental.phone.replace(/[^+\d]/g, '');
  const message = receiptSmsText(rentalOrReceipt, receiptContext);
  return sendSmsMessage(phone, message);
}

export async function sendSmsMessage(phone, message) {
  const normalizedPhone = String(phone || '').replace(/[^+\d]/g, '');
  if (!normalizedPhone) throw new Error('Telefon raqami topilmadi.');
  window.location.href = `sms:${normalizedPhone}?body=${encodeURIComponent(message)}`;
  return { result: 'unknown', message };
}

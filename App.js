import { StatusBar } from 'expo-status-bar';
import { SQLiteProvider, useSQLiteContext } from 'expo-sqlite';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  SafeAreaView,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {
  createEquipmentType,
  createRental,
  editRental,
  editRentalRecord,
  deleteEquipmentType,
  fetchEquipmentTypes,
  fetchSmsQueue,
  fetchRentals,
  getSetting,
  logSentMessage,
  markRentalItemPaid,
  migrateDatabase,
  recordRentalPayment,
  registerReturn,
  setSetting,
  queueSms,
  updateSmsQueue,
  updateEquipmentType,
  usesRemoteDatabase,
} from './src/data';
import {
  currentDebt,
  dayCount,
  formatDate,
  formatMoney,
  initials,
  isClosed,
  itemTotal,
  openQuantity,
  paidItemAmount,
  paidTotal,
  pendingItemAmount,
  receiptBreakdown,
  receiptCalculationText,
  receiptSmsText,
  receiptText,
  rentalTotal,
} from './src/utils';
import { downloadReceiptPdf, printReceipt, sendReceiptSms, sendSmsMessage } from './src/receiptActions';

const C = {
  green: '#1D4ED8',
  green2: '#93C5FD',
  lime: '#102440',
  cream: '#FACC15',
  white: '#FFFFFF',
  page: '#FACC15',
  pageInk: '#171300',
  pageMuted: '#594900',
  pageAccent: '#173B83',
  card: '#080808',
  cardRaised: '#111111',
  ink: '#FFFFFF',
  muted: '#BDBDBD',
  line: '#343434',
  orange: '#FBBF24',
  orangeSoft: '#080808',
  greenSoft: '#132238',
  blueSoft: '#102440',
  blue: '#60A5FA',
  red: '#DC2626',
  redDark: '#FF7B7B',
  redSoft: '#321313',
  redLine: '#A33A3A',
  blueLine: '#37689E',
  success: '#16A34A',
  successDark: '#4ADE80',
  neutral: '#D1D5DB',
};

export default function App() {
  if (Platform.OS === 'web' && usesRemoteDatabase) {
    return <LesaApp db={null} />;
  }
  return (
    <SQLiteProvider databaseName="lesa.db" onInit={migrateDatabase}>
      <NativeLesaApp />
    </SQLiteProvider>
  );
}

function NativeLesaApp() {
  const db = useSQLiteContext();
  return <LesaApp db={db} />;
}

function LesaApp({ db }) {
  const [screen, setScreen] = useState('home');
  const [rentals, setRentals] = useState([]);
  const [equipment, setEquipment] = useState([]);
  const [smsQueue, setSmsQueue] = useState([]);
  const [channel, setChannel] = useState('Telegram');
  const [apkUrl, setApkUrl] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [selected, setSelected] = useState(null);
  const [editTarget, setEditTarget] = useState(null);
  const [receipt, setReceipt] = useState(null);
  const [equipmentEditor, setEquipmentEditor] = useState(null);
  const [equipmentDeleteTarget, setEquipmentDeleteTarget] = useState(null);
  const [equipmentDeleteError, setEquipmentDeleteError] = useState('');
  const [installPrompt, setInstallPrompt] = useState(null);
  const [installHelpOpen, setInstallHelpOpen] = useState(false);
  const [appInstalled, setAppInstalled] = useState(false);
  const [installCapabilityChecked, setInstallCapabilityChecked] = useState(Platform.OS !== 'web');
  const [isIosWeb, setIsIosWeb] = useState(false);
  const [splashReady, setSplashReady] = useState(false);
  const [smsSending, setSmsSending] = useState(null);
  const [paymentsBackScreen, setPaymentsBackScreen] = useState('home');

  const load = useCallback(async (silent = false) => {
    if (!silent) setRefreshing(true);
    try {
      const [rentalRows, equipmentRows, savedChannel, savedApkUrl, smsRows] = await Promise.all([
        fetchRentals(db),
        fetchEquipmentTypes(db),
        getSetting(db, 'message_channel'),
        getSetting(db, 'apk_url'),
        fetchSmsQueue(db),
      ]);
      setRentals(rentalRows);
      setEquipment(equipmentRows);
      setSmsQueue(smsRows);
      if (savedChannel) setChannel(savedChannel);
      setApkUrl(savedApkUrl || '');
      return rentalRows;
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [db]);

  useEffect(() => {
    load(true);
    const timer = setInterval(() => load(true), 60_000);
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') load(true);
    });
    return () => {
      clearInterval(timer);
      subscription.remove();
    };
  }, [load]);

  useEffect(() => {
    const timer = setTimeout(() => setSplashReady(true), 1700);
    return () => clearTimeout(timer);
  }, []);

  const enqueueSms = async (payload) => {
    try {
      await queueSms(db, payload);
      setSmsQueue(await fetchSmsQueue(db));
    } catch (queueError) {
      Alert.alert('SMS navbatga qo‘shilmadi', queueError.message || 'SMS matnini navbatga qo‘shib bo‘lmadi.');
    }
  };

  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return undefined;
    const displayModeQueries = ['standalone', 'fullscreen', 'minimal-ui', 'window-controls-overlay']
      .map((mode) => window.matchMedia?.(`(display-mode: ${mode})`))
      .filter(Boolean);
    const syncDisplayMode = () => {
      const standalone = displayModeQueries.some((query) => query.matches) || window.navigator?.standalone === true;
      if (standalone) setAppInstalled(true);
    };
    syncDisplayMode();
    const userAgent = window.navigator?.userAgent || '';
    const iosDevice = /iPad|iPhone|iPod/i.test(userAgent)
      || (/Macintosh/i.test(userAgent) && Number(window.navigator?.maxTouchPoints || 0) > 1);
    setIsIosWeb(iosDevice);

    const handleBeforeInstallPrompt = (event) => {
      event.preventDefault();
      setInstallPrompt(event);
      setInstallCapabilityChecked(true);
    };
    const handleCapturedInstallPrompt = () => {
      if (window.__lesachiInstallPrompt) {
        setInstallPrompt(window.__lesachiInstallPrompt);
        setInstallCapabilityChecked(true);
      }
    };
    const handleAppInstalled = () => {
      setAppInstalled(true);
      setInstallPrompt(null);
      window.__lesachiInstallPrompt = null;
    };
    handleCapturedInstallPrompt();
    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    window.addEventListener('lesachi-install-ready', handleCapturedInstallPrompt);
    window.addEventListener('appinstalled', handleAppInstalled);
    window.addEventListener('pageshow', syncDisplayMode);
    displayModeQueries.forEach((query) => query.addEventListener?.('change', syncDisplayMode));
    const capabilityTimer = window.setTimeout(() => setInstallCapabilityChecked(true), 1800);
    return () => {
      window.clearTimeout(capabilityTimer);
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
      window.removeEventListener('lesachi-install-ready', handleCapturedInstallPrompt);
      window.removeEventListener('appinstalled', handleAppInstalled);
      window.removeEventListener('pageshow', syncDisplayMode);
      displayModeQueries.forEach((query) => query.removeEventListener?.('change', syncDisplayMode));
    };
  }, []);

  const active = useMemo(() => rentals.filter((rental) => !isClosed(rental)), [rentals]);
  const history = useMemo(() => rentals.filter(isClosed), [rentals]);
  const pendingRentals = useMemo(() => rentals.filter((rental) => pendingPaymentItems(rental).length > 0), [rentals]);
  const pendingPaymentCount = useMemo(() => pendingRentals.reduce((total, rental) => total + pendingPaymentItems(rental).length, 0), [pendingRentals]);

  const submitRental = async (payload) => {
    try {
      const rentalId = await createRental(db, payload);
      setNewOpen(false);
      const rows = await load(true);
      const created = rows.find((row) => row.id === rentalId);
      if (created) {
        await enqueueSms({ rentalId: created.id, phone: created.phone, message: receiptSmsText(created, { type: 'new' }) });
        setTimeout(() => setReceipt({ rental: created, context: { type: 'new' } }), 350);
      }
    } catch (error) {
      Alert.alert('Ijara saqlanmadi', error.message || 'Ijarani saqlashda xatolik yuz berdi.');
    }
  };

  const submitEdit = async (changes) => {
    const rentalId = editTarget?.id;
    if (!rentalId) throw new Error('Tahrirlanadigan ijara topilmadi. Oynani yopib, qayta oching.');
    try {
      const outcome = await editRental(db, rentalId, changes);
      const rows = await load(true);
      const updated = rows.find((row) => row.id === rentalId);
      setEditTarget(null);
      setSelected(null);
      if (updated) {
        if (outcome.returnedRows.length) {
          const returnType = outcome.wasClosed && !outcome.addedRows.length ? 'final' : 'partial';
          await enqueueSms({
            rentalId: updated.id,
            phone: updated.phone,
            message: receiptSmsText(updated, { type: returnType, returnedItemIds: outcome.returnedRows.map((item) => item.id) }),
          });
        }
        if (outcome.addedRows.length) {
          await enqueueSms({
            rentalId: updated.id,
            phone: updated.phone,
            message: receiptSmsText(updated, { type: 'new', addedItemIds: outcome.addedRows.map((item) => item.id) }),
          });
        }
        setTimeout(() => setReceipt({ rental: updated, context: outcome.receipt }), 350);
      }
      return outcome;
    } catch (error) {
      Alert.alert('O‘zgarishlar saqlanmadi', error.message || 'O‘zgarishlarni saqlashda xatolik yuz berdi.');
      throw error;
    }
  };

  const submitReceiptReturn = async (rental, returns, options = {}) => {
    try {
      const outcome = await registerReturn(db, rental.id, returns);
      const rows = await load(true);
      const updated = rows.find((row) => row.id === rental.id);
      if (!updated) throw new Error('Yangilangan ijara topilmadi.');
      const returnType = outcome.wasClosed ? 'final' : 'partial';
      await enqueueSms({
        rentalId: updated.id,
        phone: updated.phone,
        message: receiptSmsText(updated, {
          type: returnType,
          returnedItemIds: outcome.returnedRows.map((item) => item.id),
        }),
      });
      if (options.showReceipt !== false) setReceipt({ rental: updated, context: outcome.receipt });
      return { ok: true, rental: updated, outcome };
    } catch (error) {
      return { ok: false, error: error.message || 'Qaytarishni saqlab bo‘lmadi.' };
    }
  };

  const submitReceiptPayment = async (rental, amount, options = {}) => {
    try {
      const payment = await recordRentalPayment(db, rental.id, amount, 'Admin');
      const rows = await load(true);
      const updated = rows.find((row) => row.id === rental.id);
      if (!updated) throw new Error('Yangilangan ijara topilmadi.');
      if (options.showReceipt !== false) setReceipt({ rental: updated, context: { type: isClosed(updated) ? 'final' : 'current' } });
      return { ok: true, rental: updated, payment };
    } catch (error) {
      return { ok: false, error: error.message || 'To‘lovni saqlab bo‘lmadi.' };
    }
  };

  const submitReceiptRecordEdit = async (rental, items, options = {}) => {
    try {
      const event = await editRentalRecord(db, rental.id, items, 'Admin');
      const rows = await load(true);
      const updated = rows.find((row) => row.id === rental.id);
      if (!updated) throw new Error('Yangilangan ijara topilmadi.');
      if (options.showReceipt !== false) setReceipt({ rental: updated, context: { type: isClosed(updated) ? 'final' : 'current' } });
      return { ok: true, rental: updated, event };
    } catch (error) {
      return { ok: false, error: error.message || 'Ijara ma’lumotlarini saqlab bo‘lmadi.' };
    }
  };

  const submitDetailReturn = async (rental, returns) => {
    const result = await submitReceiptReturn(rental, returns, { showReceipt: false });
    if (result?.ok) setSelected(result.rental);
    return result;
  };

  const submitDetailPayment = async (rental, amount) => {
    const result = await submitReceiptPayment(rental, amount, { showReceipt: false });
    if (result?.ok) setSelected(result.rental);
    return result;
  };

  const submitDetailRecordEdit = async (rental, items) => {
    const result = await submitReceiptRecordEdit(rental, items, { showReceipt: false });
    if (result?.ok) setSelected(result.rental);
    return result;
  };

  const confirmPaid = async (itemId) => {
    try {
      await markRentalItemPaid(db, itemId);
      const markPaid = (rental) => {
        if (!rental?.items?.some((item) => item.id === itemId)) return rental;
        return {
          ...rental,
          items: rental.items.map((item) => item.id === itemId
            ? { ...item, paid: true, paidAmount: lineAmount(rental, item) }
            : item),
        };
      };
      setRentals((rows) => rows.map(markPaid));
      setSelected((current) => current ? markPaid(current) : current);
      load(true).catch(() => {
        // The payment is already saved. Keep the optimistic state until the next refresh.
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error.message || 'To‘lov holatini o‘zgartirib bo‘lmadi.' };
    }
  };

  const openPayments = (returnScreen) => {
    setPaymentsBackScreen(returnScreen);
    setScreen('payments');
  };

  const sendQueuedSms = async (item) => {
    setSmsSending(item.id);
    try {
      await sendSmsMessage(item.phone, item.message);
      await updateSmsQueue(db, item.id, 'sent', null);
    } catch (error) {
      await updateSmsQueue(db, item.id, 'error', error.message || 'SMS yuborilmadi.');
      Alert.alert('SMS yuborilmadi', error.message || 'SMS oynasini ochib bo‘lmadi.');
    } finally {
      setSmsSending(null);
      await load(true);
    }
  };

  const sendAllQueuedSms = async () => {
    const pending = smsQueue.filter((item) => item.status === 'pending' || item.status === 'error');
    for (const item of pending) await sendQueuedSms(item);
  };

  const changeChannel = async (next) => {
    setChannel(next);
    await setSetting(db, 'message_channel', next);
  };

  const saveApkUrl = async (nextUrl) => {
    const value = nextUrl.trim();
    if (value && !/^https:\/\/\S+$/i.test(value)) {
      throw new Error('Xavfsiz havola https:// bilan boshlanishi kerak.');
    }
    await setSetting(db, 'apk_url', value);
    setApkUrl(value);
  };

  const saveEquipment = async (payload) => {
    try {
      if (equipmentEditor?.mode === 'edit') {
        await updateEquipmentType(db, equipmentEditor.item.id, payload);
      } else {
        await createEquipmentType(db, payload);
      }
      setEquipmentEditor(null);
      await load(true);
    } catch (error) {
      Alert.alert('Anjom saqlanmadi', error.message || 'Anjomni saqlashda xatolik yuz berdi.');
      throw error;
    }
  };

  const handleDeleteEquipment = (item) => {
    setEquipmentDeleteError('');
    setEquipmentDeleteTarget(item);
  };

  const confirmDeleteEquipment = async () => {
    if (!equipmentDeleteTarget) return;
    try {
      await deleteEquipmentType(db, equipmentDeleteTarget.id);
      setEquipmentDeleteTarget(null);
      setEquipmentDeleteError('');
      await load(true);
    } catch (error) {
      setEquipmentDeleteError(error.message || 'Anjomni o‘chirib bo‘lmadi.');
    }
  };

  const installApp = async () => {
    if (Platform.OS !== 'web') {
      Alert.alert('Web ilovasi', 'Ilovani o‘rnatish uchun saytni HTTPS manzilda oching.');
      return;
    }
    if (appInstalled) {
      setInstallHelpOpen(true);
      return;
    }
    const promptEvent = installPrompt || window.__lesachiInstallPrompt;
    if (!promptEvent) {
      setInstallHelpOpen(true);
      return;
    }
    try {
      await promptEvent.prompt();
      const choice = await promptEvent.userChoice;
      if (choice?.outcome === 'accepted') setAppInstalled(true);
    } catch (error) {
      setInstallHelpOpen(true);
    } finally {
      setInstallPrompt(null);
      window.__lesachiInstallPrompt = null;
      setInstallCapabilityChecked(true);
    }
  };

  const downloadApk = () => {
    const url = apkUrl.trim();
    if (!url || Platform.OS !== 'web' || typeof document === 'undefined') return;
    const link = document.createElement('a');
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.download = 'Lesachi.apk';
    document.body.appendChild(link);
    link.click();
    link.remove();
  };

  const shareReceipt = async (receiptData) => {
    const { rental, context } = receiptData;
    const message = receiptText(rental, context);
    try {
      const result = await Share.share({ title: 'LESA elektron chek', message });
      const status = result.action === Share.sharedAction ? 'sent' : 'cancelled';
      await logSentMessage(db, rental.id, channel, message, status);
      if (status === 'sent') setReceipt(null);
    } catch (error) {
      await logSentMessage(db, rental.id, channel, message, 'error');
      Alert.alert('Xatolik', 'Chekni yuborib bo‘lmadi. Qayta urinib ko‘ring.');
    }
  };

  const saveReceiptPdf = async (receiptData) => {
    try {
      await downloadReceiptPdf(receiptData.rental, receiptData.context);
    } catch (error) {
      Alert.alert('PDF xatoligi', error.message || 'PDF faylini yaratib bo‘lmadi.');
    }
  };

  const printRentalReceipt = async (receiptData) => {
    try {
      await printReceipt(receiptData.rental, receiptData.context);
    } catch (error) {
      Alert.alert('Chop etish xatoligi', error.message || 'Chekni chop etib bo‘lmadi.');
    }
  };

  const smsReceipt = async (receiptData) => {
    const { rental, context } = receiptData;
    const message = receiptSmsText(rental, context);
    try {
      const result = await sendReceiptSms(rental, context);
      await logSentMessage(db, rental.id, 'SMS', result?.message || message, result?.result || 'unknown');
    } catch (error) {
      await logSentMessage(db, rental.id, 'SMS', message, 'error');
      Alert.alert('SMS xatoligi', error.message || 'SMS oynasini ochib bo‘lmadi.');
    }
  };

  if (!splashReady) {
    return <Splash />;
  }

  if (loading) {
    return <View style={s.loader}><Logo size={64} /><ActivityIndicator color={C.green} size="small" /></View>;
  }

  return (
    <SafeAreaView style={s.safe}>
      <StatusBar style="dark" />
      <View style={s.app}>
        {screen === 'home' && (
          <Dashboard
            rentals={active}
            pendingRentals={pendingRentals}
            refreshing={refreshing}
            onRefresh={() => load()}
            onNew={() => setNewOpen(true)}
            onRental={setSelected}
            onPayments={() => openPayments('home')}
            installAvailable={Boolean(installPrompt)}
            installCapabilityChecked={installCapabilityChecked}
            installed={appInstalled}
            isIos={isIosWeb}
            apkUrl={apkUrl}
            onInstall={installApp}
            onInstallHelp={() => setInstallHelpOpen(true)}
            onDownloadApk={downloadApk}
          />
        )}
        {screen === 'customers' && <Customers rentals={rentals} onRental={setSelected} />}
        {screen === 'history' && (
          <History rentals={history} refreshing={refreshing} onRefresh={() => load()} onReceipt={(rental) => setReceipt({ rental, context: { type: 'final' } })} />
        )}
        {screen === 'payments' && <Payments rentals={pendingRentals} refreshing={refreshing} onRefresh={() => load()} onBack={() => setScreen(paymentsBackScreen)} onPay={confirmPaid} onRental={setSelected} />}
        {screen === 'settings' && <Settings channel={channel} onChange={changeChannel} apkUrl={apkUrl} onSaveApkUrl={saveApkUrl} onPayments={() => openPayments('settings')} paymentPendingCount={pendingPaymentCount} onInventory={() => setScreen('inventory')} onSmsQueue={() => setScreen('sms')} smsPendingCount={smsQueue.filter((item) => item.status === 'pending').length} onDownloadApk={downloadApk} remoteMode={usesRemoteDatabase} />}
        {screen === 'sms' && <SmsQueue items={smsQueue} sending={smsSending} onSend={sendQueuedSms} onSendAll={sendAllQueuedSms} onBack={() => setScreen('settings')} />}
        {screen === 'inventory' && <Inventory equipment={equipment} refreshing={refreshing} onRefresh={() => load()} onBack={() => setScreen('settings')} onAdd={() => setEquipmentEditor({ mode: 'create', item: null })} onEdit={(item) => setEquipmentEditor({ mode: 'edit', item })} onDelete={handleDeleteEquipment} />}

        <BottomNav screen={screen === 'payments' ? paymentsBackScreen : screen} onChange={setScreen} />
      </View>

      <NewRentalModal open={newOpen} equipment={equipment} onClose={() => setNewOpen(false)} onSubmit={submitRental} />
      <RentalDetail
        rental={selected}
        equipment={equipment}
        onClose={() => setSelected(null)}
        onPay={confirmPaid}
        onReturnAll={submitDetailReturn}
        onPaymentAmount={submitDetailPayment}
        onRecordEdit={submitDetailRecordEdit}
        onReceipt={(rental) => { setSelected(null); setReceipt({ rental, context: { type: isClosed(rental) ? 'final' : 'current' } }); }}
      />
      <RentalEditModal target={editTarget} equipment={equipment} onClose={() => setEditTarget(null)} onSubmit={submitEdit} />
      <EquipmentModal editor={equipmentEditor} onClose={() => setEquipmentEditor(null)} onSubmit={saveEquipment} />
      <EquipmentDeleteModal item={equipmentDeleteTarget} error={equipmentDeleteError} onClose={() => { setEquipmentDeleteTarget(null); setEquipmentDeleteError(''); }} onConfirm={confirmDeleteEquipment} />
      <InstallAppModal open={installHelpOpen} installed={appInstalled} isIos={isIosWeb} onClose={() => setInstallHelpOpen(false)} />
      <ReceiptModal
        receipt={receipt}
        channel={channel}
        onClose={() => setReceipt(null)}
        onDownload={saveReceiptPdf}
        onPrint={printRentalReceipt}
        onSms={smsReceipt}
        onShare={shareReceipt}
        onReturn={submitReceiptReturn}
        onPayment={submitReceiptPayment}
        onRecordEdit={submitReceiptRecordEdit}
        equipment={equipment}
      />
    </SafeAreaView>
  );
}

function Logo({ size = 42 }) {
  return <View style={[s.logoFrame, { width: size, height: size, borderRadius: size / 2 }]}><Image source={require('./assets/lesachi-logo.png')} resizeMode="contain" style={{ width: size - 8, height: size - 8, borderRadius: Math.max(0, size / 2 - 4) }} /></View>;
}

function Splash() {
  return <View style={s.splash}><Logo size={120} /><Text style={s.splashTitle}>Lesachi</Text><Text style={s.splashSub}>Ijara boshqaruvi tizimi</Text></View>;
}

function Brand({ compact = false }) {
  const size = compact ? 40 : 44;
  return <View style={s.brand}><Logo size={size} /><View><Text style={s.brandName}>Lesachi</Text><Text style={s.brandSub}>IJARA BOSHQARUVI</Text></View></View>;
}

function Header({ title, subtitle, action }) {
  return <View style={s.header}><View><Text style={s.headerTitle}>{title}</Text><Text style={s.headerSub}>{subtitle}</Text></View>{action}</View>;
}

function openItems(rental) {
  return rental.items.filter((item) => item.status === 'open' || (!item.status && openQuantity(item) > 0));
}

function returnedItems(rental) {
  return rental.items.filter((item) => item.status === 'returned' || (!item.status && openQuantity(item) === 0));
}

function pendingPaymentItems(rental) {
  return returnedItems(rental).filter((item) => pendingItemAmount(rental, item) > 0);
}

function paidReturnedItems(rental) {
  return returnedItems(rental).filter((item) => (
    paidItemAmount(rental, item) > 0 && pendingItemAmount(rental, item) === 0
  ));
}

function pendingPaymentTotal(rental) {
  return pendingPaymentItems(rental).reduce((total, item) => total + pendingItemAmount(rental, item), 0);
}

function quantityOf(items) {
  return items.reduce((total, item) => total + Number(item.quantity || 0), 0);
}

function lineAmount(rental, item) {
  return Number(item.amount ?? item.frozenAmount ?? itemTotal(rental, item));
}

function activityTitle(event, uppercase = false) {
  let title;
  if (event.type === 'payment') title = `To‘lov · ${formatMoney(event.amount)}`;
  else if (event.type === 'edit') title = `Tahrirlandi · ${(event.details?.after || []).length || 1} ta qator`;
  else title = `Qaytarildi · ${event.quantity} dona`;
  return uppercase ? title.toUpperCase() : title;
}

function activityIcon(event) {
  if (event.type === 'payment') return { name: 'cash-check', color: C.successDark, style: s.activityIconPayment };
  if (event.type === 'edit') return { name: 'pencil-outline', color: C.green2, style: s.activityIconEdit };
  return { name: 'package-down', color: C.orange, style: s.activityIconReturn };
}

function statusTone(days) {
  if (days >= 14) return { color: C.red, background: '#FDECEC', label: 'Uzoq muddat' };
  if (days >= 7) return { color: C.blue, background: C.blueSoft, label: 'O‘rtacha muddat' };
  return { color: C.neutral, background: '#F9FAFB', label: 'Yangi' };
}

function Dashboard({ rentals, pendingRentals, refreshing, onRefresh, onNew, onRental, onPayments, installAvailable, installCapabilityChecked, installed, isIos, apkUrl, onInstall, onInstallHelp, onDownloadApk }) {
  const [query, setQuery] = useState('');
  const filtered = rentals.filter((rental) => `${rental.customerName} ${rental.phone}`.toLowerCase().includes(query.toLowerCase()));
  const debt = rentals.reduce((total, rental) => total + currentDebt(rental), 0);
  const pendingTotal = pendingRentals.reduce((total, rental) => total + pendingPaymentTotal(rental), 0);
  const customerCount = new Set(rentals.map((rental) => rental.phone)).size;

  return (
    <FlatList
      style={s.screen}
      contentContainerStyle={s.screenContent}
      data={filtered}
      keyExtractor={(item) => item.id}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={C.green} />}
      ListHeaderComponent={<>
        <View style={s.topBrand}><Brand /><Pressable style={s.smallAdd} onPress={onNew}><Text style={s.smallAddText}>＋</Text></Pressable></View>
        <Header title="Asosiy" subtitle={new Intl.DateTimeFormat('uz-UZ', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date())} />
        <InstallPromotion
          installAvailable={installAvailable}
          capabilityChecked={installCapabilityChecked}
          installed={installed}
          isIos={isIos}
          apkUrl={apkUrl}
          onInstall={onInstall}
          onInstallHelp={onInstallHelp}
          onDownloadApk={onDownloadApk}
        />
        <View style={s.metricGrid}>
          <View style={s.metricCard}><Text style={s.metricLabel}>FAOL IJARALAR</Text><Text style={s.metricValue}>{rentals.length}</Text><Text style={s.metricHint}>{customerCount} faol mijoz</Text></View>
          <View style={[s.metricCard, s.metricCardAmber, { backgroundColor: C.card, borderColor: C.redLine }]}><Text style={[s.metricLabelAmber, { color: C.redDark }]}>JAMI QARZ</Text><Text style={[s.metricValueAmber, { color: C.redDark }]}>{formatMoney(debt)}</Text><Text style={[s.metricHintAmber, { color: C.redDark }]}>real-time hisob</Text></View>
        </View>
        <Pressable style={s.dashboardAddButton} onPress={onNew}><Text style={s.dashboardAddText}>＋  Yangi ijara qo‘shish</Text></Pressable>
        {pendingRentals.length > 0 && <View style={s.pendingPanel}>
          <View style={s.pendingPanelHead}><View><Text style={s.pendingPanelTitle}>To‘lov kutilmoqda</Text><Text style={s.pendingPanelSub}>Buyum qaytdi, to‘lov hali tasdiqlanmagan</Text></View><Text style={s.pendingPanelTotal}>{formatMoney(pendingTotal)}</Text></View>
          {pendingRentals.map((rental) => <Pressable key={rental.id} style={s.pendingPanelRow} onPress={() => onRental(rental)}><View style={s.flex}><Text style={s.customerName}>{rental.customerName}</Text><Text style={s.phone}>{quantityOf(pendingPaymentItems(rental))} dona qaytgan anjom</Text></View><Text style={s.pendingPanelAmount}>{formatMoney(pendingPaymentTotal(rental))}</Text></Pressable>)}
          <Pressable style={s.pendingPanelAction} onPress={onPayments}><Text style={s.pendingPanelActionText}>To‘lovlarni tasdiqlash</Text><Text style={s.pendingPanelActionArrow}>›</Text></Pressable>
        </View>}
        <View style={s.sectionTitleRow}><View><Text style={s.sectionTitle}>Faol mijozlar</Text><Text style={s.sectionSub}>Qaytarilishi kutilayotgan ijaralar</Text></View><Text style={s.resultCount}>{filtered.length} ta</Text></View>
        <View style={s.searchBox}><Text style={s.searchIcon}>⌕</Text><TextInput value={query} onChangeText={setQuery} placeholder="Mijoz yoki telefon..." placeholderTextColor="#99A39F" style={s.searchInput} /></View>
      </>}
      renderItem={({ item }) => <RentalCard rental={item} onPress={() => onRental(item)} />}
      ItemSeparatorComponent={() => <View style={{ height: 12 }} />}
      ListEmptyComponent={<Empty title="Faol ijara yo‘q" text="Birinchi ijarani rasmiylashtirish uchun + tugmasini bosing." action="Yangi ijara" onPress={onNew} />}
    />
  );
}

function RentalCard({ rental, onPress }) {
  const remainingItems = openItems(rental);
  const returnedQuantity = quantityOf(returnedItems(rental));
  const pendingItems = pendingPaymentItems(rental);
  const days = dayCount(rental.startedAt);
  const tone = statusTone(days);
  return (
    <Pressable style={({ pressed }) => [s.rentalCard, { borderLeftColor: tone.color }, pressed && s.pressed]} onPress={onPress}>
      <View style={s.customerRow}><View style={[s.avatar, { backgroundColor: tone.background }]}><Text style={[s.avatarText, { color: tone.color }]}>{initials(rental.customerName)}</Text></View><View style={s.flex}><Text style={s.customerName}>{rental.customerName}</Text><Text style={s.phone}>{days} kundan beri qaytarmagan</Text></View><View style={s.cardAmount}><Text style={s.cardAmountLabel}>JORIY QARZ</Text><Text style={[s.cardAmountValue, { color: C.redDark }]}>{formatMoney(currentDebt(rental))}</Text></View></View>
      <View style={s.cardDivider} />
      <View style={s.rentalMeta}><Meta label="MIJOZDA" value={`${quantityOf(remainingItems)} dona`} /><Meta label="HOLAT" value={tone.label} /><Meta label="KUNLIK" value={formatMoney(remainingItems.reduce((total, item) => total + Number(item.dailyPrice || 0) * Number(item.quantity || 0), 0))} /></View>
      {returnedQuantity > 0 && <View style={s.cardPaidNote}><Text style={[s.cardPaidNoteText, { color: pendingItems.length ? C.orange : C.successDark }]}>{pendingItems.length ? `! ${quantityOf(pendingItems)} dona qaytdi · ${formatMoney(pendingPaymentTotal(rental))} to‘lov kutilmoqda` : `✓ ${returnedQuantity} dona qaytarilgan · ${formatMoney(paidTotal(rental))} to‘langan`}</Text></View>}
    </Pressable>
  );
}

function Meta({ label, value, accent }) {
  return <View style={s.meta}><Text style={s.metaLabel}>{label}</Text><Text numberOfLines={1} style={[s.metaValue, accent && { color: C.blue }]}>{value}</Text></View>;
}

function History({ rentals, refreshing, onRefresh, onReceipt }) {
  return (
    <FlatList
      style={s.screen}
      contentContainerStyle={s.screenContent}
      data={rentals}
      keyExtractor={(item) => item.id}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={C.green} />}
      ListHeaderComponent={<><View style={s.topBrand}><Brand /></View><Header title="Ijara tarixi" subtitle="Yakunlangan hisob-kitoblar" /></>}
      renderItem={({ item }) => <Pressable style={s.historyCard} onPress={() => onReceipt(item)}><View style={s.historyTop}><View style={s.avatar}><Text style={s.avatarText}>{initials(item.customerName)}</Text></View><View style={s.flex}><Text style={s.customerName}>{item.customerName}</Text><Text style={s.phone}>{formatDate(item.closedAt || new Date(), true)}</Text></View><View style={s.doneBadge}><Text style={[s.doneText, { color: pendingPaymentItems(item).length ? C.orange : C.successDark }]}>{pendingPaymentItems(item).length ? 'TO‘LOV KUTILMOQDA' : 'YOPILGAN'}</Text></View></View><View style={s.cardDivider} /><View style={s.historyBottom}><Text style={s.historyItems}>{item.items.length} turdagi anjom</Text><Text style={s.historyTotal}>{formatMoney(rentalTotal(item))}</Text></View></Pressable>}
      ItemSeparatorComponent={() => <View style={{ height: 12 }} />}
      ListEmptyComponent={<Empty title="Tarix hozircha bo‘sh" text="To‘liq qaytarilgan ijaralar shu yerda ko‘rinadi." />}
    />
  );
}

function Customers({ rentals, onRental }) {
  const customers = Array.from(rentals.reduce((map, rental) => {
    const key = rental.phone || rental.customerName;
    const existing = map.get(key);
    if (existing) {
      existing.debt += currentDebt(rental);
      existing.rentals.push(rental);
    } else {
      map.set(key, { id: key, name: rental.customerName, phone: rental.phone, debt: currentDebt(rental), rentals: [rental] });
    }
    return map;
  }, new Map()).values());

  return <FlatList style={s.screen} contentContainerStyle={s.screenContent} data={customers} keyExtractor={(item) => item.id} ListHeaderComponent={<><View style={s.topBrand}><Brand /></View><Header title="Mijozlar" subtitle="Faol mijozlar va joriy qarzlar" /></>} renderItem={({ item }) => <Pressable style={s.customerListCard} onPress={() => onRental(item.rentals[0])}><View style={s.avatar}><Text style={s.avatarText}>{initials(item.name)}</Text></View><View style={s.flex}><Text style={s.customerName}>{item.name}</Text><Text style={s.phone}>{item.phone} · {item.rentals.length} ta ijara</Text></View><Text style={[s.customerDebt, { color: C.redDark }]}>{formatMoney(item.debt)}</Text></Pressable>} ItemSeparatorComponent={() => <View style={{ height: 8 }} />} ListEmptyComponent={<Empty title="Mijozlar hozircha yo‘q" text="Yangi ijara qo‘shilganda mijoz shu yerda chiqadi." />} />;
}

function Inventory({ equipment, refreshing, onRefresh, onBack, onAdd, onEdit, onDelete }) {
  const totalQuantity = equipment.reduce((sum, item) => sum + Number(item.totalQuantity || 0), 0);

  return (
    <ScrollView
      style={s.screen}
      contentContainerStyle={s.screenContent}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={C.green} />}
    >
      <View style={s.inventoryTopRow}>
        <Pressable style={s.inventoryBackButton} onPress={onBack} hitSlop={8}><Text style={s.inventoryBackText}>‹</Text></Pressable>
        <Text style={s.inventoryTitle}>Ombor</Text>
        <View style={{ width: 36 }} />
      </View>
      <Text style={s.inventorySubtitle}>Anjomlar va mavjud qoldiq</Text>

      <View style={s.inventoryMetricGrid}>
        <View style={s.inventoryMetricCard}>
          <Text style={s.inventoryMetricLabel}>ANJOM TURLARI</Text>
          <Text style={s.inventoryMetricValue}>{equipment.length}</Text>
          <Text style={s.inventoryMetricHint}>ombordagi tur</Text>
        </View>
        <View style={[s.inventoryMetricCard, s.inventoryMetricCardAmber, { borderColor: C.blueLine }]}>
          <Text style={s.inventoryMetricLabelAmber}>JAMI DONA</Text>
          <Text style={s.inventoryMetricValueAmber}>{totalQuantity}</Text>
          <Text style={s.inventoryMetricHintAmber}>barcha turlar bo‘yicha</Text>
        </View>
      </View>

      <Pressable style={s.inventoryAddButton} onPress={onAdd}><Text style={s.inventoryAddText}>＋ Yangi anjom qo‘shish</Text></Pressable>
      <View style={s.sectionTitleRow}><View><Text style={s.sectionTitle}>Anjomlar</Text><Text style={s.sectionSub}>Band va mavjud son avtomatik hisoblanadi</Text></View><Text style={s.resultCount}>{equipment.length} ta</Text></View>

      {equipment.map((item) => {
        const depleted = Number(item.availableQuantity || 0) <= 0;
        return (
          <View key={item.id} style={[s.inventoryCard, depleted && s.inventoryCardDepleted]}>
            <View style={s.inventoryCardTop}>
              <View style={s.flex}><Text style={s.inventoryName}>{item.name}</Text><Text style={s.inventoryDaily}>{formatMoney(item.dailyPrice)} / kun</Text></View>
            </View>
            <View style={s.inventoryStats}>
              <View style={s.inventoryStat}><Text style={s.inventoryStatLabel}>JAMI</Text><Text style={s.inventoryStatValue}>{item.totalQuantity}</Text></View>
              <View style={s.inventoryStat}><Text style={s.inventoryStatLabel}>BAND</Text><Text style={s.inventoryStatValue}>{item.rentedQuantity}</Text></View>
              <View style={s.inventoryStat}><Text style={s.inventoryStatLabel}>MAVJUD</Text><View style={s.inventoryAvailableRow}><Text style={depleted ? s.inventoryStatValueDepleted : s.inventoryStatValueAvailable}>{item.availableQuantity}</Text>{depleted && <Text style={s.inventoryUnavailable}>Tugadi</Text>}</View></View>
            </View>
            <View style={s.inventoryMenuRow}>
              <Pressable style={s.inventoryMenuAction} onPress={() => onEdit(item)}><Text style={s.inventoryMenuActionText}>Tahrirlash</Text></Pressable>
              <Pressable style={s.inventoryMenuActionDanger} onPress={() => onDelete(item)}><Text style={s.inventoryMenuActionDangerText}>O‘chirish</Text></Pressable>
            </View>
          </View>
        );
      })}
      {!equipment.length && <Empty title="Ombor bo‘sh" text="Yangi anjom qo‘shilganda shu yerda ko‘rinadi." action="Yangi anjom qo‘shish" onPress={onAdd} />}
    </ScrollView>
  );
}

function EquipmentModal({ editor, onClose, onSubmit }) {
  const item = editor?.item;
  const [name, setName] = useState('');
  const [dailyPrice, setDailyPrice] = useState('');
  const [totalQuantity, setTotalQuantity] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (editor) {
      setName(item?.name || '');
      setDailyPrice(item ? String(item.dailyPrice) : '');
      setTotalQuantity(item ? String(item.totalQuantity) : '');
      setSaving(false);
    }
  }, [editor?.mode, item?.id]);

  const submit = async () => {
    const cleanName = name.trim();
    if (String(dailyPrice).trim() === '') return Alert.alert('Narx noto‘g‘ri', 'Kunlik narxni kiriting.');
    if (String(totalQuantity).trim() === '') return Alert.alert('Miqdor noto‘g‘ri', 'Umumiy miqdorni kiriting.');
    const price = Number(dailyPrice);
    const quantity = Number(totalQuantity);
    if (!cleanName) return Alert.alert('Ma’lumot yetarli emas', 'Anjom nomini kiriting.');
    if (!Number.isSafeInteger(price) || price < 0) return Alert.alert('Narx noto‘g‘ri', 'Kunlik narxni butun, manfiy bo‘lmagan son qilib kiriting.');
    if (!Number.isSafeInteger(quantity) || quantity < 0) return Alert.alert('Miqdor noto‘g‘ri', 'Umumiy miqdorni 0 yoki undan katta butun son qilib kiriting.');
    setSaving(true);
    try {
      await onSubmit({ name: cleanName, dailyPrice: price, totalQuantity: quantity });
    } catch (error) {
      // The parent shows a translated database error. Keep the modal open for correction.
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal visible={Boolean(editor)} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={s.modalPage}>
        <KeyboardAvoidingView style={s.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <ScrollView contentContainerStyle={s.modalContent} keyboardShouldPersistTaps="handled">
            <ModalHeader title={item ? 'Anjomni tahrirlash' : 'Yangi anjom qo‘shish'} subtitle="Ombor ma’lumotlari" onClose={onClose} />
            <Field label="ANJOM NOMI"><TextInput style={s.input} value={name} onChangeText={setName} placeholder="Masalan, Lesa komplekti" placeholderTextColor="#9AA49F" /></Field>
            <Field label="KUNLIK IJARA NARXI"><TextInput style={s.input} value={dailyPrice} onChangeText={(value) => setDailyPrice(value.replace(/[^0-9]/g, ''))} keyboardType="number-pad" placeholder="25000" placeholderTextColor="#9AA49F" /></Field>
            <Field label="UMUMIY MIQDOR"><TextInput style={s.input} value={totalQuantity} onChangeText={(value) => setTotalQuantity(value.replace(/[^0-9]/g, ''))} keyboardType="number-pad" placeholder="20" placeholderTextColor="#9AA49F" /></Field>
            <Text style={s.equipmentModalHint}>Band va mavjud miqdor faol ijaralardan avtomatik hisoblanadi.</Text>
            <Pressable disabled={saving} style={[s.mainButton, saving && { opacity: .6 }]} onPress={submit}>{saving ? <ActivityIndicator color={C.white} /> : <Text style={s.mainButtonText}>Saqlash</Text>}</Pressable>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}

function EquipmentDeleteModal({ item, error, onClose, onConfirm }) {
  return (
    <Modal visible={Boolean(item)} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={s.modalPage}>
        <ScrollView contentContainerStyle={s.modalContent}>
          <ModalHeader title={error ? 'O‘chirib bo‘lmaydi' : 'Anjomni o‘chirish'} subtitle="Ombor ma’lumotlari" onClose={onClose} />
          {error ? (
            <View style={s.deleteErrorBox}><Text style={s.deleteErrorText}>{error}</Text></View>
          ) : (
            <>
              <Text style={s.deleteConfirmText}>{item?.name} anjomi ombordan o‘chirilsinmi?</Text>
              <Text style={s.equipmentModalHint}>Tarixiy cheklar saqlanib qoladi. Faol ijarada band bo‘lgan anjomni o‘chirib bo‘lmaydi.</Text>
              <View style={s.deleteActions}>
                <Pressable style={s.deleteCancelButton} onPress={onClose}><Text style={s.deleteCancelText}>Bekor qilish</Text></Pressable>
                <Pressable style={s.deleteConfirmButton} onPress={onConfirm}><Text style={s.deleteConfirmTextButton}>O‘chirish</Text></Pressable>
              </View>
            </>
          )}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

function SmsQueue({ items, sending, onSend, onSendAll, onBack }) {
  const pending = items.filter((item) => item.status === 'pending' || item.status === 'error');
  return <ScrollView style={s.screen} contentContainerStyle={s.screenContent}>
    <View style={s.inventoryTopRow}><Pressable style={s.inventoryBackButton} onPress={onBack} hitSlop={8}><Text style={s.inventoryBackText}>‹</Text></Pressable><Text style={s.inventoryTitle}>SMS navbati</Text><View style={{ width: 36 }} /></View>
    <Text style={s.inventorySubtitle}>Xabarlar avval navbatga tushadi, yuborish faqat qo‘lda tasdiqlanadi.</Text>
    {pending.length > 0 && <Pressable style={s.inventoryAddButton} onPress={onSendAll} disabled={Boolean(sending)}><Text style={s.inventoryAddText}>Barchasini yuborish ({pending.length})</Text></Pressable>}
    {items.map((item) => <View key={item.id} style={s.smsQueueCard}>
      <View style={s.smsQueueHead}><View style={s.flex}><Text style={s.customerName}>{item.phone}</Text><Text style={s.phone}>{formatDate(item.createdAt, true)}</Text></View><Text style={[s.smsQueueStatus, { color: item.status === 'sent' ? C.successDark : item.status === 'error' ? C.redDark : C.orange }]}>{item.status === 'sent' ? 'YUBORILDI' : item.status === 'error' ? 'XATOLIK' : 'KUTILMOQDA'}</Text></View>
      <Text style={s.smsQueueMessage}>{item.message}</Text>
      {item.errorMessage && <Text style={s.smsQueueError}>{item.errorMessage}</Text>}
      {(item.status === 'pending' || item.status === 'error') && <Pressable style={s.smsQueueSend} onPress={() => onSend(item)} disabled={Boolean(sending)}><Text style={s.smsQueueSendText}>{sending === item.id ? 'Yuborilmoqda...' : 'Yuborish'}</Text></Pressable>}
    </View>)}
    {!items.length && <Empty title="SMS navbati bo‘sh" text="Ijara yoki qaytarishdan keyin xabar shu yerga qo‘shiladi." />}
  </ScrollView>;
}

function Payments({ rentals, refreshing, onRefresh, onBack, onPay, onRental }) {
  const [paymentTarget, setPaymentTarget] = useState(null);
  const [payingItemId, setPayingItemId] = useState(null);
  const [paymentError, setPaymentError] = useState('');
  const paymentCount = rentals.reduce((total, rental) => total + pendingPaymentItems(rental).length, 0);
  const paymentTotal = rentals.reduce((total, rental) => total + pendingPaymentTotal(rental), 0);

  const openConfirmation = (rental, item) => {
    setPaymentError('');
    setPaymentTarget({ rental, item });
  };

  const closeConfirmation = () => {
    if (payingItemId) return;
    setPaymentError('');
    setPaymentTarget(null);
  };

  const confirmPayment = async () => {
    if (!paymentTarget || payingItemId) return;
    setPayingItemId(paymentTarget.item.id);
    setPaymentError('');
    try {
      const result = await onPay(paymentTarget.item.id);
      if (result?.ok) {
        setPaymentTarget(null);
      } else {
        setPaymentError(result?.error || 'To‘lov holatini saqlab bo‘lmadi.');
      }
    } catch (error) {
      setPaymentError(error.message || 'To‘lov holatini saqlab bo‘lmadi.');
    } finally {
      setPayingItemId(null);
    }
  };

  return <>
    <ScrollView
      style={s.screen}
      contentContainerStyle={s.screenContent}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={C.green} />}
    >
      <View style={s.inventoryTopRow}>
        <Pressable style={s.inventoryBackButton} onPress={onBack} hitSlop={8}><Text style={s.inventoryBackText}>‹</Text></Pressable>
        <Text style={s.inventoryTitle}>To‘lovlar</Text>
        <View style={{ width: 40 }} />
      </View>
      <Text style={s.inventorySubtitle}>Qaytarilgan, lekin hali to‘langani tasdiqlanmagan anjomlar</Text>

      <View style={s.paymentMetricGrid}>
        <View style={s.paymentMetricCard}>
          <Text style={s.paymentMetricLabel}>KUTILAYOTGAN TO‘LOVLAR</Text>
          <Text style={s.paymentMetricCount}>{paymentCount}</Text>
          <Text style={s.paymentMetricHint}>tasdiqlanmagan hisob</Text>
        </View>
        <View style={[s.paymentMetricCard, s.paymentMetricTotalCard]}>
          <Text style={s.paymentMetricLabel}>JAMI SUMMA</Text>
          <Text style={s.paymentMetricTotal}>{formatMoney(paymentTotal)}</Text>
          <Text style={s.paymentMetricHint}>muzlatilgan qarz</Text>
        </View>
      </View>

      {refreshing && <View style={s.paymentLoading}><ActivityIndicator color={C.green} /><Text style={s.paymentLoadingText}>To‘lovlar yangilanmoqda...</Text></View>}

      {rentals.map((rental) => {
        const items = pendingPaymentItems(rental);
        return <View key={rental.id} style={s.paymentGroupCard}>
          <View style={s.paymentCustomerHead}>
            <View style={s.avatar}><Text style={s.avatarText}>{initials(rental.customerName)}</Text></View>
            <View style={s.flex}><Text style={s.customerName}>{rental.customerName}</Text><Text style={s.phone}>{rental.phone} · {items.length} ta to‘lov</Text></View>
            <Pressable style={s.paymentCustomerButton} onPress={() => onRental(rental)}><Text style={s.paymentCustomerButtonText}>Ko‘rish</Text></Pressable>
          </View>
          {items.map((item) => <View key={item.id} style={s.paymentItemRow}>
            <View style={s.paymentItemTop}>
              <View style={s.flex}>
                <Text style={s.paymentItemName}>{item.name} × {item.quantity}</Text>
                <Text style={s.paymentItemMeta}>Qaytdi: {formatDate(item.returnedAt, true)} · {dayCount(item.startedAt || rental.startedAt, item.returnedAt)} kun</Text>
              </View>
              <Text style={s.paymentItemAmount}>{formatMoney(pendingItemAmount(rental, item))}</Text>
            </View>
            <Pressable style={s.paymentApproveButton} onPress={() => openConfirmation(rental, item)}>
              <MaterialCommunityIcons name="cash-check" size={25} color={C.white} />
              <Text style={s.paymentApproveText}>To‘lovni tasdiqlash</Text>
            </Pressable>
          </View>)}
        </View>;
      })}

      {!rentals.length && !refreshing && <Empty title="Tasdiqlanmagan to‘lov yo‘q" text="Qaytarilgan anjom uchun to‘lov kutilsa, u shu sahifada ko‘rinadi." />}
    </ScrollView>
    <PaymentConfirmModal target={paymentTarget} busy={Boolean(payingItemId)} error={paymentError} onClose={closeConfirmation} onConfirm={confirmPayment} />
  </>;
}

function PaymentConfirmModal({ target, busy, error, onClose, onConfirm }) {
  const amount = target ? pendingItemAmount(target.rental, target.item) : 0;
  return <Modal visible={Boolean(target)} transparent animationType="fade" onRequestClose={onClose}>
    <View style={s.paymentConfirmOverlay}>
      <View style={s.paymentConfirmCard}>
        <View style={s.paymentConfirmIcon}><MaterialCommunityIcons name="cash-check" size={32} color={C.successDark} /></View>
        <Text style={s.paymentConfirmTitle}>To‘lovni tasdiqlaysizmi?</Text>
        <Text style={s.paymentConfirmText}>Pul haqiqatan olingan bo‘lsa tasdiqlang. Bu anjom “To‘landi” holatiga o‘tadi.</Text>
        {target && <View style={s.paymentConfirmSummary}>
          <Text style={s.paymentConfirmCustomer}>{target.rental.customerName}</Text>
          <Text style={s.paymentConfirmItem}>{target.item.name} × {target.item.quantity}</Text>
          <Text style={s.paymentConfirmAmount}>{formatMoney(amount)}</Text>
        </View>}
        {error ? <View style={s.paymentConfirmError}><Text style={s.paymentConfirmErrorText}>{error}</Text></View> : null}
        <View style={s.paymentConfirmActions}>
          <Pressable disabled={busy} style={[s.paymentCancelButton, busy && s.paymentButtonDisabled]} onPress={onClose}><Text style={s.paymentCancelText}>Bekor qilish</Text></Pressable>
          <Pressable disabled={busy} style={[s.paymentConfirmButton, busy && s.paymentButtonDisabled]} onPress={onConfirm}>
            {busy ? <ActivityIndicator color={C.white} /> : <Text style={s.paymentConfirmButtonText}>Ha, to‘landi</Text>}
          </Pressable>
        </View>
      </View>
    </View>
  </Modal>;
}

function Settings({ channel, onChange, apkUrl, onSaveApkUrl, onPayments, paymentPendingCount, onInventory, onSmsQueue, smsPendingCount, onDownloadApk, remoteMode }) {
  const [apkDraft, setApkDraft] = useState(apkUrl);
  const [apkSaving, setApkSaving] = useState(false);
  const [apkStatus, setApkStatus] = useState(null);
  const storageLabel = remoteMode ? 'Umumiy Supabase bazasi' : 'Qurilma SQLite bazasi';
  const storageNote = remoteMode
    ? 'Production rejimida barcha ma’lumotlar umumiy onlayn bazada saqlanadi va boshqa foydalanuvchilarga ko‘rinadi.'
    : 'Lokal rejimda ma’lumotlar shu qurilmaning o‘zida saqlanadi.';

  useEffect(() => {
    setApkDraft(apkUrl);
  }, [apkUrl]);

  const saveApk = async () => {
    setApkSaving(true);
    setApkStatus(null);
    try {
      await onSaveApkUrl(apkDraft);
      setApkStatus({ type: 'success', text: apkDraft.trim() ? 'APK havolasi saqlandi.' : 'APK yuklab olish tugmasi yashirildi.' });
    } catch (error) {
      setApkStatus({ type: 'error', text: error.message || 'APK havolasini saqlab bo‘lmadi.' });
    } finally {
      setApkSaving(false);
    }
  };

  return (
    <ScrollView style={s.screen} contentContainerStyle={s.screenContent}>
      <View style={s.topBrand}><Brand /></View>
      <Header title="Sozlamalar" subtitle="Ilova va xabar yuborish" />
      <View style={s.settingsCard}><Text style={s.settingsTitle}>Chek yuborish kanali</Text><Text style={s.settingsText}>Mijozga chek ulashilganda birlamchi kanal sifatida ishlatiladi.</Text><View style={s.channelGrid}>{['SMS', 'Telegram', 'WhatsApp'].map((item) => <Pressable key={item} onPress={() => onChange(item)} style={[s.channel, channel === item && s.channelActive]}><Text style={[s.channelText, channel === item && s.channelTextActive]}>{item}</Text></Pressable>)}</View></View>
      {Platform.OS === 'web' && <>
        <Pressable disabled={!apkUrl.trim()} style={[installS.installCard, !apkUrl.trim() && { opacity: .6 }]} onPress={onDownloadApk}>
          <View style={installS.installIcon}><MaterialCommunityIcons name="cellphone-arrow-down" size={25} color={C.green2} /></View>
          <View style={s.flex}><Text style={s.settingsTitle}>Ilova versiyasi</Text><Text style={s.settingsText}>{apkUrl.trim() ? 'APK faylini telefonga yuklab olish uchun bosing.' : 'APK fayli hali tayyor emas.'}</Text></View>
          <Text style={installS.installArrow}>›</Text>
        </Pressable>
        <View style={s.settingsCard}>
          <Text style={s.settingsTitle}>APK fayl havolasi</Text>
          <Text style={s.settingsText}>Administrator uchun: faqat ishonchli HTTPS APK manzilini kiriting. Bo‘sh saqlansa, yuklab olish tugmasi bosh sahifada ko‘rinmaydi.</Text>
          <TextInput
            value={apkDraft}
            onChangeText={(value) => { setApkDraft(value); setApkStatus(null); }}
            style={installS.apkInput}
            placeholder="https://sayt.uz/Lesachi.apk"
            placeholderTextColor="#9CA3AF"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
          />
          {apkStatus && <Text style={[installS.apkStatus, apkStatus.type === 'error' ? installS.apkStatusError : installS.apkStatusSuccess]}>{apkStatus.text}</Text>}
          <Pressable disabled={apkSaving} style={[installS.apkSaveButton, apkSaving && { opacity: .6 }]} onPress={saveApk}>
            {apkSaving ? <ActivityIndicator color={C.white} /> : <Text style={installS.apkSaveText}>APK havolasini saqlash</Text>}
          </Pressable>
        </View>
      </>}
      <View style={s.settingsCard}><Text style={s.settingsTitle}>Ma’lumotlar</Text><InfoRow label="Saqlash" value={storageLabel} /><InfoRow label="Hisoblash" value="Real-time, cron ishlatilmaydi" /><InfoRow label="Versiya" value="1.0.0 MVP" /></View>
      <Pressable style={[s.inventoryLink, paymentPendingCount > 0 && s.paymentMenuLinkActive]} onPress={onPayments}>
        <View style={s.paymentMenuIcon}><MaterialCommunityIcons name="cash-check" size={28} color={C.green2} /></View>
        <View style={s.flex}><Text style={s.settingsTitle}>To‘lovlarni tasdiqlash</Text><Text style={s.settingsText}>{paymentPendingCount ? `${paymentPendingCount} ta to‘lov tasdiqlanishi kutilmoqda` : 'Hozir tasdiqlanmagan to‘lov yo‘q'}</Text></View>
        {paymentPendingCount > 0 && <View style={s.paymentMenuBadge}><Text style={s.paymentMenuBadgeText}>{paymentPendingCount}</Text></View>}
        <Text style={s.inventoryArrow}>›</Text>
      </Pressable>
      <Pressable style={s.inventoryLink} onPress={onInventory}><View><Text style={s.settingsTitle}>Ombor jadvali</Text><Text style={s.settingsText}>Anjomlar va faol ijaradagi sonlarni ko‘rish</Text></View><Text style={s.inventoryArrow}>›</Text></Pressable>
      <Pressable style={s.inventoryLink} onPress={onSmsQueue}><View><Text style={s.settingsTitle}>SMS navbati</Text><Text style={s.settingsText}>{smsPendingCount ? `${smsPendingCount} ta xabar yuborishni kutmoqda` : 'Yuborilgan va kutilayotgan xabarlar'}</Text></View><Text style={s.inventoryArrow}>›</Text></Pressable>
      <View style={s.note}><Text style={s.noteTitle}>Eslatma</Text><Text style={s.noteText}>{storageNote} SMS/Telegram/WhatsApp yuborish uchun tegishli API ulanishi kerak.</Text></View>
    </ScrollView>
  );
}

function InstallPromotion({ installAvailable, capabilityChecked, installed, isIos, apkUrl, onInstall, onInstallHelp, onDownloadApk }) {
  if (Platform.OS !== 'web' || installed) return null;

  if (installAvailable) {
    return <View style={installS.promoBanner}>
      <View style={installS.promoIcon}><MaterialCommunityIcons name="cellphone-arrow-down" size={30} color="#8A6D12" /></View>
      <View style={s.flex}><Text style={installS.promoTitle}>Ilovani telefonga o‘rnating</Text><Text style={installS.promoText}>Lesachi alohida ilova kabi ochiladi va bosh ekranda ikonka paydo bo‘ladi.</Text></View>
      <Pressable style={installS.promoButton} onPress={onInstall}><Text style={installS.promoButtonText}>O‘rnatish</Text></Pressable>
    </View>;
  }

  if (!capabilityChecked) return null;
  const hasApk = Boolean(apkUrl?.trim());
  if (!isIos && !hasApk) return null;

  return <View style={installS.promoBanner}>
    <View style={installS.promoIcon}><MaterialCommunityIcons name={isIos ? 'export-variant' : 'android'} size={30} color="#8A6D12" /></View>
    <View style={s.flex}>
      <Text style={installS.promoTitle}>{isIos ? 'iPhone’ga o‘rnating' : 'Android ilovasini yuklab oling'}</Text>
      <Text style={installS.promoText}>{isIos ? 'Safari’da Share → Add to Home Screen orqali saytni ilova sifatida qo‘shing.' : 'Brauzer PWA oynasini ko‘rsatmadi. Tayyor APK faylni yuklab olishingiz mumkin.'}</Text>
      <View style={installS.promoActions}>
        {isIos && <Pressable style={installS.promoOutlineButton} onPress={onInstallHelp}><Text style={installS.promoOutlineText}>Ko‘rsatmani ko‘rish</Text></Pressable>}
        {hasApk && <Pressable style={installS.promoButton} onPress={onDownloadApk}><Text style={installS.promoButtonText}>{isIos ? 'Android uchun APK' : 'APK faylni yuklab olish'}</Text></Pressable>}
      </View>
    </View>
  </View>;
}

function InfoRow({ label, value }) {
  return <View style={s.infoRow}><Text style={s.infoLabel}>{label}</Text><Text style={s.infoValue}>{value}</Text></View>;
}

function InstallAppModal({ open, installed, isIos, onClose }) {
  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={onClose}>
      <View style={installS.installOverlay}>
        <View style={installS.installModal}>
          <View style={installS.installModalIcon}><MaterialCommunityIcons name="cellphone-arrow-down" size={30} color={C.green2} /></View>
          <Text style={installS.installModalTitle}>{installed ? 'Ilova o‘rnatilgan' : 'Ilovani o‘rnatish'}</Text>
          {isIos
            ? <Text style={installS.installModalText}>Safari pastki menyusidagi Share belgisini bosing, so‘ng “Add to Home Screen”ni tanlab, “Add” bilan tasdiqlang.</Text>
            : <><Text style={installS.installModalText}>Android Chrome’da brauzer menyusidan “Install app” yoki “Add to Home screen”ni tanlang.</Text><Text style={installS.installModalText}>iPhone’da Safari → Share → “Add to Home Screen”ni bosing.</Text></>}
          <Pressable style={installS.installCloseButton} onPress={onClose}><Text style={installS.installCloseText}>Yopish</Text></Pressable>
        </View>
      </View>
    </Modal>
  );
}

function BottomNav({ screen, onChange }) {
  return <View style={s.bottomNav}>
    <NavButton active={screen === 'home'} icon="home-variant-outline" activeIcon="home-variant" label="Asosiy" onPress={() => onChange('home')} />
    <NavButton active={screen === 'customers'} icon="account-group-outline" activeIcon="account-group" label="Mijozlar" onPress={() => onChange('customers')} />
    <NavButton active={screen === 'inventory'} icon="warehouse" activeIcon="warehouse" label="Ombor" onPress={() => onChange('inventory')} />
    <NavButton active={screen === 'history'} icon="history" activeIcon="history" label="Tarix" onPress={() => onChange('history')} />
    <NavButton active={screen === 'settings'} icon="cog-outline" activeIcon="cog" label="Sozlama" onPress={() => onChange('settings')} />
  </View>;
}

function NavButton({ active, icon, activeIcon, label, onPress }) {
  return <Pressable style={[s.navButton, active && s.navButtonActive]} onPress={onPress}>
    <View style={[s.navIconWrap, active && s.navIconWrapActive]}>
      <MaterialCommunityIcons name={active ? activeIcon : icon} size={28} color={active ? C.green : C.muted} />
    </View>
    <Text style={[s.navLabel, active && s.navActive]}>{label}</Text>
  </Pressable>;
}

function Empty({ title, text, action, onPress }) {
  return <View style={s.empty}><View style={s.emptyIcon}><Text style={s.emptyIconText}>▦</Text></View><Text style={s.emptyTitle}>{title}</Text><Text style={s.emptyText}>{text}</Text>{action && <Pressable style={s.emptyButton} onPress={onPress}><Text style={s.emptyButtonText}>{action}</Text></Pressable>}</View>;
}

function NewRentalModal({ open, equipment, onClose, onSubmit }) {
  const blank = () => ({ key: `${Date.now()}_${Math.random()}`, name: '', quantity: '0', dailyPrice: '' });
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [items, setItems] = useState([blank()]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) { setName(''); setPhone(''); setItems([blank()]); setSaving(false); }
  }, [open]);

  const updateItem = (key, field, value) => setItems((rows) => rows.map((row) => row.key === key ? { ...row, [field]: value } : row));
  const chooseEquipment = (key, selectedName) => {
    const type = equipment.find((entry) => entry.name === selectedName);
    setItems((rows) => rows.map((row) => row.key === key ? { ...row, name: type.name, dailyPrice: String(type.dailyPrice) } : row));
  };
  const daily = items.reduce((sum, item) => sum + (Number(item.quantity) || 0) * (Number(item.dailyPrice) || 0), 0);

  const submit = async () => {
    const cleanItems = items.map((item) => ({ name: item.name.trim(), quantity: Number(item.quantity), dailyPrice: Number(item.dailyPrice) }));
    if (!name.trim() || !phone.trim()) return Alert.alert('Ma’lumot yetarli emas', 'Mijoz ismi va telefon raqamini kiriting.');
    if (cleanItems.some((item) => !item.name || item.quantity < 1 || item.dailyPrice < 0)) return Alert.alert('Anjomlarni tekshiring', 'Har bir anjomning nomi, soni va kunlik narxini to‘g‘ri kiriting.');
    setSaving(true);
    try { await onSubmit({ customerName: name.trim(), phone: phone.trim(), items: cleanItems }); } finally { setSaving(false); }
  };

  return (
    <Modal visible={open} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={s.modalPage}><KeyboardAvoidingView style={s.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}><ScrollView contentContainerStyle={s.modalContent} keyboardShouldPersistTaps="handled">
        <ModalHeader title="Yangi ijara" subtitle="Mijoz va anjom ma’lumotlari" onClose={onClose} />
        <Field label="MIJOZ ISMI-FAMILIYASI"><TextInput style={s.input} value={name} onChangeText={setName} placeholder="Masalan, Aliyev Akmal" placeholderTextColor="#9AA49F" /></Field>
        <Field label="TELEFON RAQAMI"><TextInput style={s.input} value={phone} onChangeText={setPhone} keyboardType="phone-pad" placeholder="+998 90 123 45 67" placeholderTextColor="#9AA49F" /></Field>
        <View style={s.itemsHeader}><Text style={s.itemsTitle}>Anjomlar</Text><Text style={s.itemsCount}>{items.length} tur</Text></View>
        {items.map((item, index) => <View key={item.key} style={s.itemEditor}><View style={s.itemEditorTop}><Text style={s.itemNumber}>ANJOM {index + 1}</Text>{items.length > 1 && <Pressable onPress={() => setItems((rows) => rows.filter((row) => row.key !== item.key))}><Text style={s.removeText}>O‘chirish</Text></Pressable>}</View><TextInput style={s.input} value={item.name} onChangeText={(value) => updateItem(item.key, 'name', value)} placeholder="Anjom nomi" placeholderTextColor="#9AA49F" /><ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.suggestions}>{equipment.map((type) => <Pressable key={type.id} onPress={() => chooseEquipment(item.key, type.name)} style={[s.suggestion, item.name === type.name && s.suggestionActive, item.name === type.name && { borderColor: C.blueLine }]}><Text style={[s.suggestionText, item.name === type.name && s.suggestionTextActive]}>{type.name}</Text></Pressable>)}</ScrollView><View style={s.twoColumns}><Field style={s.flex} label="SONI"><TextInput style={s.input} value={item.quantity} onChangeText={(value) => updateItem(item.key, 'quantity', value.replace(/[^0-9]/g, ''))} keyboardType="number-pad" /></Field><Field style={s.flex} label="KUNLIK NARX"><TextInput style={s.input} value={item.dailyPrice} onChangeText={(value) => updateItem(item.key, 'dailyPrice', value.replace(/[^0-9]/g, ''))} keyboardType="number-pad" placeholder="0" placeholderTextColor="#9AA49F" /></Field></View></View>)}
        <Pressable style={s.addItem} onPress={() => setItems((rows) => [...rows, blank()])}><Text style={s.addItemText}>＋ Yana anjom qo‘shish</Text></Pressable>
        <View style={[s.dailyTotal, { borderColor: C.blueLine }]}><Text style={s.dailyLabel}>Bir kunlik umumiy ijara</Text><Text style={s.dailyValue}>{formatMoney(daily)}</Text></View>
        <Pressable disabled={saving} style={[s.mainButton, saving && { opacity: .6 }]} onPress={submit}>{saving ? <ActivityIndicator color={C.white} /> : <Text style={s.mainButtonText}>Ijarani rasmiylashtirish</Text>}</Pressable>
      </ScrollView></KeyboardAvoidingView></SafeAreaView>
    </Modal>
  );
}

function RentalDetail({ rental, equipment, onClose, onPay, onReturnAll, onPaymentAmount, onRecordEdit, onReceipt }) {
  const activeItems = rental ? openItems(rental) : [];
  const pendingItems = rental ? pendingPaymentItems(rental) : [];
  const paidItems = rental ? paidReturnedItems(rental) : [];
  const activity = Array.isArray(rental?.activity) ? rental.activity : [];
  const activeQuantity = quantityOf(activeItems);
  const [paymentTarget, setPaymentTarget] = useState(null);
  const [paymentBusy, setPaymentBusy] = useState(false);
  const [paymentError, setPaymentError] = useState('');
  const [returnAllOpen, setReturnAllOpen] = useState(false);
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [recordEditOpen, setRecordEditOpen] = useState(false);

  useEffect(() => {
    setPaymentTarget(null);
    setPaymentBusy(false);
    setPaymentError('');
    setReturnAllOpen(false);
    setPaymentOpen(false);
    setRecordEditOpen(false);
  }, [rental?.id]);

  const confirmDetailPayment = async () => {
    if (!paymentTarget || paymentBusy) return;
    setPaymentBusy(true);
    setPaymentError('');
    try {
      const result = await onPay(paymentTarget.item.id);
      if (result?.ok) {
        setPaymentTarget(null);
      } else {
        setPaymentError(result?.error || 'To‘lov holatini saqlab bo‘lmadi.');
      }
    } catch (error) {
      setPaymentError(error.message || 'To‘lov holatini saqlab bo‘lmadi.');
    } finally {
      setPaymentBusy(false);
    }
  };

  const closeDetailPayment = () => {
    if (paymentBusy) return;
    setPaymentTarget(null);
    setPaymentError('');
  };

  return <><Modal visible={Boolean(rental)} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>{rental && <SafeAreaView style={s.modalPage}><ScrollView contentContainerStyle={s.modalContent}>
    <ModalHeader title={rental.customerName} subtitle={rental.phone} onClose={onClose} />
    <View style={[s.detailSummary, { backgroundColor: C.card, borderColor: C.redLine }]}>
      <Text style={[s.detailLabel, { color: C.redDark }]}>JORIY JAMI QARZ</Text>
      <Text style={[s.detailTotal, { color: C.redDark }]}>{formatMoney(currentDebt(rental))}</Text>
      <Text style={s.detailDate}>{activeQuantity ? `${activeQuantity} dona hali mijozda · ` : 'Barcha anjomlar qaytarilgan · '}olingan: {formatDate(rental.startedAt, true)}</Text>
    </View>

    {activeItems.length > 0 && <>
      <View style={s.detailSectionHeader}><Text style={s.itemsTitle}>Joriy holat</Text><Text style={s.detailSectionCount}>{activeQuantity} dona mijozda</Text></View>
      {activeItems.map((item) => <View key={item.id} style={s.detailItem}>
        <View style={s.detailItemTop}><View style={s.flex}><Text style={s.detailItemName}>{item.name} × {item.quantity}</Text><Text style={s.detailItemSub}>Olingan: {formatDate(item.startedAt || rental.startedAt, true)} · {formatMoney(item.dailyPrice)}/kun</Text></View><Text style={[s.detailItemTotal, { color: C.redDark }]}>{formatMoney(itemTotal(rental, item))}</Text></View>
      </View>)}
    </>}

    {pendingItems.length > 0 && <>
      <View style={s.detailSectionHeader}><Text style={s.itemsTitle}>To‘lov kutilmoqda</Text><Text style={[s.paidSectionTotal, { color: C.orange }]}>{formatMoney(pendingPaymentTotal(rental))}</Text></View>
      {pendingItems.map((item) => <View key={item.id} style={[s.returnHistoryItem, s.pendingPaymentCard]}>
        <View style={s.detailItemTop}><View style={s.flex}><Text style={s.detailItemName}>↩ {item.name} × {item.quantity}</Text><Text style={s.detailItemSub}>{formatDate(item.returnedAt, true)} · {dayCount(item.startedAt || rental.startedAt, item.returnedAt)} kun · {paidItemAmount(rental, item) > 0 ? `${formatMoney(paidItemAmount(rental, item))} qisman to‘landi` : 'to‘lov kutilmoqda'}</Text></View><Text style={[s.returnHistoryAmount, { color: C.orange }]}>{formatMoney(pendingItemAmount(rental, item))}</Text></View>
        <View style={s.pendingPaymentFooter}><Text style={[s.paidBadgeText, { color: C.green2 }]}>BUYUM QAYTDI</Text><Pressable style={s.paidConfirmButton} onPress={() => { setPaymentError(''); setPaymentTarget({ rental, item }); }}><Text style={s.paidConfirmText}>To‘landi</Text></Pressable></View>
      </View>)}
    </>}

    {paidItems.length > 0 && <>
      <View style={s.detailSectionHeader}><Text style={s.itemsTitle}>Qaytarish tarixi</Text><Text style={[s.paidSectionTotal, { color: C.successDark }]}>{formatMoney(paidTotal(rental))} to‘langan</Text></View>
      {paidItems.map((item) => <View key={item.id} style={s.returnHistoryItem}>
        <View style={s.detailItemTop}><View style={s.flex}><Text style={s.detailItemName}>✓ {item.name} × {item.quantity}</Text><Text style={s.detailItemSub}>{formatDate(item.returnedAt, true)} · {dayCount(item.startedAt || rental.startedAt, item.returnedAt)} kun</Text></View><Text style={[s.returnHistoryAmount, { color: C.successDark }]}>{formatMoney(lineAmount(rental, item))}</Text></View>
        <View style={s.paidBadge}><Text style={[s.paidBadgeText, { color: C.successDark }]}>TO‘LANDI</Text></View>
      </View>)}
    </>}

    {activity.length > 0 && <>
      <View style={s.detailSectionHeader}><Text style={s.itemsTitle}>Amallar tarixi</Text><Text style={s.detailSectionCount}>{activity.length} ta amal</Text></View>
      <View style={s.activityCard}>{activity.map((event) => {
        const icon = activityIcon(event);
        return <View key={event.id} style={s.activityRow}>
          <View style={[s.activityIcon, icon.style]}><MaterialCommunityIcons name={icon.name} size={23} color={icon.color} /></View>
          <View style={s.flex}><Text style={s.activityTitle}>{activityTitle(event)}</Text><Text style={s.activityMeta}>{formatDate(event.createdAt, true)} · {event.actor || 'Admin'}</Text></View>
        </View>;
      })}</View>
    </>}

    <View style={[s.receiptRecordStack, s.detailRecordStack]}>
      <Pressable disabled={!activeItems.length} style={({ pressed }) => [s.receiptRecordButton, s.receiptEditButton, (pressed || !activeItems.length) && s.receiptRecordDisabled]} onPress={() => setRecordEditOpen(true)}><MaterialCommunityIcons name="pencil-outline" size={27} color={C.white} /><Text style={s.receiptEditButtonText}>Tahrirlash</Text></Pressable>
      <Pressable disabled={!activeItems.length} style={({ pressed }) => [s.receiptRecordButton, s.receiptReturnButton, (pressed || !activeItems.length) && s.receiptRecordDisabled]} onPress={() => setReturnAllOpen(true)}><MaterialCommunityIcons name="package-check" size={27} color={C.orange} /><Text style={s.receiptReturnButtonText}>Hammasi qaytarildi</Text></Pressable>
      <Pressable disabled={pendingPaymentTotal(rental) <= 0} style={({ pressed }) => [s.receiptRecordButton, s.receiptPaidButton, (pressed || pendingPaymentTotal(rental) <= 0) && s.receiptRecordDisabled]} onPress={() => setPaymentOpen(true)}><MaterialCommunityIcons name="cash-check" size={27} color={C.white} /><Text style={s.receiptPaidButtonText}>To‘landi</Text></Pressable>
    </View>
    <Pressable style={s.receiptButton} onPress={() => onReceipt(rental)}><Text style={s.receiptButtonText}>▧  {isClosed(rental) ? 'Yakuniy chekni ko‘rish' : 'Elektron chekni ko‘rish'}</Text></Pressable>
  </ScrollView></SafeAreaView>}</Modal><PaymentConfirmModal target={paymentTarget} busy={paymentBusy} error={paymentError} onClose={closeDetailPayment} onConfirm={confirmDetailPayment} /><AllReturnConfirmModal open={returnAllOpen} rental={rental} onClose={() => setReturnAllOpen(false)} onSubmit={onReturnAll} /><PaymentReceiptModal open={paymentOpen} rental={rental} onClose={() => setPaymentOpen(false)} onSubmit={onPaymentAmount} /><RentalRecordEditModal open={recordEditOpen} rental={rental} equipment={equipment} onClose={() => setRecordEditOpen(false)} onSubmit={onRecordEdit} /></>;
}

function RentalEditModal({ target, equipment, onClose, onSubmit }) {
  const activeItems = target ? openItems(target) : [];
  const blankAddition = () => ({ key: `add_${Date.now()}_${Math.random()}`, equipmentTypeId: null, quantity: '1' });
  const [remainingQuantities, setRemainingQuantities] = useState({});
  const [additionRows, setAdditionRows] = useState([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  useEffect(() => {
    if (target) {
      setRemainingQuantities(Object.fromEntries(openItems(target).map((item) => [item.id, String(item.quantity)])));
      setAdditionRows([]);
      setSaving(false);
      setSaveError('');
    }
  }, [target?.id]);

  const remainingFor = (item) => Number(remainingQuantities[item.id] ?? item.quantity ?? 0);
  const returnedFor = (item) => Math.max(0, Number(item.quantity || 0) - remainingFor(item));
  const releasedForEquipment = (equipmentTypeId) => activeItems.reduce((total, item) => (
    item.equipmentTypeId === equipmentTypeId ? total + returnedFor(item) : total
  ), 0);
  const availableForEquipment = (item) => Number(item?.availableQuantity || 0) + releasedForEquipment(item?.id);

  const updateRemainingQuantity = (itemId, value) => {
    setSaveError('');
    setRemainingQuantities((values) => ({ ...values, [itemId]: value.replace(/[^0-9]/g, '') }));
  };
  const updateAddition = (key, changes) => {
    setSaveError('');
    setAdditionRows((rows) => rows.map((row) => row.key === key ? { ...row, ...changes } : row));
  };
  const removeAddition = (key) => {
    setSaveError('');
    setAdditionRows((rows) => rows.filter((row) => row.key !== key));
  };

  const selectedEquipmentIds = new Set(additionRows.map((row) => row.equipmentTypeId).filter(Boolean));
  const availableUnselectedCount = (equipment || []).filter((item) => availableForEquipment(item) > 0 && !selectedEquipmentIds.has(item.id)).length;
  const blankAdditionCount = additionRows.filter((row) => !row.equipmentTypeId).length;
  const canAddMore = availableUnselectedCount > blankAdditionCount;
  const addAddition = () => {
    setSaveError('');
    if (!canAddMore) {
      setSaveError('Qo‘shish uchun omborda bo‘sh anjom yo‘q. Avval qaytgan anjom sonini kiriting yoki Omborda zaxirani oshiring.');
      return;
    }
    setAdditionRows((rows) => [...rows, blankAddition()]);
  };

  const submit = async () => {
    setSaveError('');
    const invalidRemaining = activeItems.find((item) => {
      const remaining = remainingFor(item);
      return !Number.isFinite(remaining) || remaining < 0 || remaining > Number(item.quantity || 0);
    });
    if (invalidRemaining) {
      setSaveError(`${invalidRemaining.name} uchun mijozda qolgan son 0 dan ${invalidRemaining.quantity} tagacha bo‘lishi kerak.`);
      return;
    }
    const returns = activeItems.map((item) => ({ itemId: item.id, quantity: returnedFor(item) })).filter((entry) => entry.quantity > 0);
    const releasedByType = activeItems.reduce((map, item) => {
      const returned = returnedFor(item);
      if (returned && item.equipmentTypeId) map[item.equipmentTypeId] = (map[item.equipmentTypeId] || 0) + returned;
      return map;
    }, {});

    const missingEquipment = additionRows.find((row) => !row.equipmentTypeId);
    if (missingEquipment) {
      setSaveError('Qo‘shiladigan anjomni tanlang yoki bo‘sh qatorni o‘chiring.');
      return;
    }
    const invalidQuantity = additionRows.find((row) => !Number.isFinite(Number(row.quantity)) || Number(row.quantity) < 1);
    if (invalidQuantity) {
      setSaveError('Qo‘shiladigan anjom sonini 1 yoki undan katta qilib kiriting.');
      return;
    }
    const additions = additionRows.map((row) => {
      const item = (equipment || []).find((entry) => entry.id === row.equipmentTypeId);
      return item ? {
        equipmentTypeId: item.id,
        name: item.name,
        dailyPrice: item.dailyPrice,
        quantity: Number(row.quantity),
      } : null;
    }).filter(Boolean);
    const additionTotals = additions.reduce((map, item) => {
      map[item.equipmentTypeId] = (map[item.equipmentTypeId] || 0) + item.quantity;
      return map;
    }, {});
    const invalidAdd = (equipment || []).find((item) => Number(additionTotals[item.id] || 0) > Number(item.availableQuantity || 0) + Number(releasedByType[item.id] || 0));
    if (invalidAdd) {
      setSaveError(`${invalidAdd.name} uchun omborda faqat ${Number(invalidAdd.availableQuantity || 0) + Number(releasedByType[invalidAdd.id] || 0)} dona mavjud.`);
      return;
    }
    if (!returns.length && !additions.length) {
      onClose();
      return;
    }
    setSaving(true);
    try {
      await onSubmit({ returns, additions });
    } catch (error) {
      setSaveError(error.message || 'O‘zgarishlarni saqlab bo‘lmadi. Qayta urinib ko‘ring.');
    } finally {
      setSaving(false);
    }
  };

  return <Modal visible={Boolean(target)} transparent animationType="fade" onRequestClose={onClose}><View style={s.overlay}><KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={s.returnSheet}>{target && <>
    <ModalHeader title="Tahrirlash" subtitle={target.customerName} onClose={onClose} />
    <ScrollView style={s.returnItemsScroll} contentContainerStyle={s.returnItemsList} keyboardShouldPersistTaps="always">
      {activeItems.length > 0 && <>
        <Text style={s.itemsTitle}>Mijozdagi anjomlar</Text>
        <Text style={s.returnHint}>Maydonda mijozdagi hozirgi son turadi. Anjom qaytsa, mijozda qolgan sonni yozing. Masalan, 4 tadan 1 ta qaytsa — 3 yozing.</Text>
        {activeItems.map((item) => <View key={item.id} style={s.returnItemCard}>
          <View style={s.returnItemHeading}><View style={s.flex}><Text style={s.detailItemName}>{item.name}</Text><Text style={s.returnItemMeta}>Olib ketgan: {item.quantity} ta · {formatMoney(item.dailyPrice)}/kun</Text></View><Text style={s.returnMax}>Qaytgan: {returnedFor(item)} ta</Text></View>
          <Field label="MIJOZDA QOLGAN SONI"><TextInput style={s.input} value={remainingQuantities[item.id] ?? String(item.quantity)} onChangeText={(value) => updateRemainingQuantity(item.id, value)} keyboardType="number-pad" selectTextOnFocus placeholder="0" placeholderTextColor="#9AA49F" /></Field>
        </View>)}
      </>}
      {additionRows.length > 0 && <Text style={[s.itemsTitle, { marginTop: 14 }]}>Qo‘shiladigan anjomlar</Text>}
      {additionRows.map((row) => {
        const selected = (equipment || []).find((item) => item.id === row.equipmentTypeId);
        const options = (equipment || []).filter((item) => availableForEquipment(item) > 0 && (item.id === row.equipmentTypeId || !selectedEquipmentIds.has(item.id)));
        return <View key={row.key} style={s.returnItemCard}>
          <View style={s.returnItemHeading}><View style={s.flex}><Text style={s.detailItemName}>{selected?.name || 'Anjomni tanlang'}</Text>{selected && <Text style={s.returnItemMeta}>Omborda mavjud: {availableForEquipment(selected)} ta · {formatMoney(selected.dailyPrice)}/kun</Text>}</View><Pressable onPress={() => removeAddition(row.key)}><Text style={s.removeText}>O‘chirish</Text></Pressable></View>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.suggestions}>{options.map((item) => <Pressable key={item.id} onPress={() => updateAddition(row.key, { equipmentTypeId: item.id, quantity: '1' })} style={[s.suggestion, row.equipmentTypeId === item.id && s.suggestionActive]}><Text style={[s.suggestionText, row.equipmentTypeId === item.id && s.suggestionTextActive]}>{item.name} · {availableForEquipment(item)} ta</Text></Pressable>)}</ScrollView>
          {selected ? <Field label="QO‘SHILADIGAN SON"><TextInput style={s.input} value={row.quantity} onChangeText={(value) => updateAddition(row.key, { quantity: value.replace(/[^0-9]/g, '') })} keyboardType="number-pad" selectTextOnFocus placeholder="1" placeholderTextColor="#9AA49F" /></Field> : <Text style={s.returnHint}>Yuqoridagi ro‘yxatdan anjomni tanlang.</Text>}
        </View>;
      })}
      <Pressable style={s.addItem} onPress={addAddition}><Text style={s.addItemText}>＋ Yana anjom qo‘shish</Text></Pressable>
    </ScrollView>
    {saveError ? <View style={s.editSaveError}><MaterialCommunityIcons name="alert-circle-outline" size={24} color={C.redDark} /><Text style={s.editSaveErrorText}>{saveError}</Text></View> : null}
    <Pressable disabled={saving} style={[s.mainButton, saving && { opacity: .65 }]} onPress={submit}>{saving ? <ActivityIndicator color={C.white} /> : <Text style={s.mainButtonText}>Saqlash</Text>}</Pressable>
  </>}</KeyboardAvoidingView></View></Modal>;
}

function ReceiptModal({ receipt, channel, equipment, onClose, onDownload, onPrint, onSms, onShare, onReturn, onPayment, onRecordEdit }) {
  const [busy, setBusy] = useState(null);
  const [returnAllOpen, setReturnAllOpen] = useState(false);
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [recordEditOpen, setRecordEditOpen] = useState(false);
  const rental = receipt?.rental;
  const context = receipt?.context || { type: 'current' };
  const breakdown = rental ? receiptBreakdown(rental, context) : null;
  const type = context.type || 'current';
  const isPartial = type === 'partial';
  const isEdit = type === 'edit';
  const isFinal = type === 'final' || breakdown?.isFinal;
  const returned = breakdown?.returnedItems || [];
  const added = breakdown?.addedItems || [];
  const remaining = isEdit ? (breakdown?.otherOpenItems || []) : (breakdown?.openItems || []);
  const returnedTotal = breakdown?.returnedTotal ?? 0;
  const current = breakdown?.currentDebt ?? 0;
  const final = breakdown?.finalTotal ?? rentalTotal(rental || { items: [] });
  const pendingReturned = returned.filter((item) => item.outstandingAmount > 0);
  const returnedOutstanding = pendingReturned.reduce((sum, item) => sum + item.outstandingAmount, 0);
  const returnedPaid = returned.reduce((sum, item) => sum + item.paidAmount, 0);
  const allPending = rental ? pendingPaymentTotal(rental) : 0;
  const allPaid = rental ? paidTotal(rental) : 0;
  const returnableItems = rental ? openItems(rental) : [];
  const activity = Array.isArray(rental?.activity) ? rental.activity : [];
  const title = isEdit ? 'Ijara o‘zgarishi cheki' : isPartial ? 'Qisman qaytarish cheki' : isFinal ? 'Yakuniy chek' : type === 'new' ? 'Yangi ijara cheki' : 'Joriy elektron chek';
  useEffect(() => setBusy(null), [rental?.id, type, context.returnedItemIds?.join(','), context.addedItemIds?.join(',')]);
  const run = async (name, action) => {
    setBusy(name);
    try { await action(receipt); } finally { setBusy(null); }
  };
  return <><Modal visible={Boolean(rental)} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>{rental && <SafeAreaView style={s.modalPage}><ScrollView contentContainerStyle={s.modalContent}>
    <ModalHeader title={title} subtitle={isEdit ? 'Qaytarish va qo‘shimcha anjomlar' : isPartial ? 'Qaytarilgan qism bo‘yicha to‘lov' : isFinal ? 'Barcha anjomlar qaytarilgan' : 'Hisob real vaqtda yangilanadi'} onClose={onClose} />
    <View style={s.receiptPaper}>
      <View style={s.receiptHead}><Brand /><Text style={s.receiptNumber}>#{rental.id.slice(-8).toUpperCase()}</Text></View>
      <View style={s.receiptCustomer}><Text style={s.receiptName}>{rental.customerName}</Text><Text style={s.phone}>{rental.phone}</Text><Text style={s.receiptDate}>{formatDate(new Date(), true)}</Text></View>

      {returned.length > 0 && <>
        <Text style={s.receiptSectionTitle}>{isPartial ? 'QAYTARILGAN QISM' : 'QAYTARILGAN ANJOMLAR'}</Text>
        {returned.map((item) => <View key={item.id} style={s.receiptRow}><View style={s.flex}><Text style={s.receiptItemName}>{item.paid ? '✓' : item.paidAmount > 0 ? '◐' : '◷'} {item.name}</Text><Text style={s.receiptItemSub}>{receiptCalculationText(item)} · {item.paid ? 'TO‘LANDI' : item.paidAmount > 0 ? `${formatMoney(item.paidAmount)} TO‘LANDI · ${formatMoney(item.outstandingAmount)} QOLDI` : 'TO‘LOV KUTILMOQDA'}</Text></View></View>)}
      </>}

      {isEdit && added.length > 0 && <>
        <Text style={s.receiptSectionTitle}>QO‘SHIMCHA OLINGAN ANJOMLAR</Text>
        {added.map((item) => <View key={item.id} style={s.receiptRow}><View style={s.flex}><Text style={s.receiptItemName}>＋ {item.name}</Text><Text style={s.receiptItemSub}>{receiptCalculationText(item)} · BUGUN OLINDI · JORIY QARZ</Text></View></View>)}
      </>}

      {!isFinal && remaining.length > 0 && <View style={[s.receiptCurrentBlock, { backgroundColor: C.card, borderColor: C.redLine }]}>
        <Text style={[s.receiptCurrentTitle, { color: C.redDark }]}>JORIY QARZ — O‘SISHDA DAVOM ETMOQDA</Text>
        {remaining.map((item) => <View key={item.id} style={s.receiptOpenRow}><Text style={s.receiptItemName}>{item.name}</Text><Text style={[s.receiptItemSub, { color: C.redDark }]}>{receiptCalculationText(item)}</Text></View>)}
        <Text style={[s.receiptCurrentTotal, { color: C.redDark, borderTopColor: C.redLine }]}>{formatMoney(current)}</Text>
        {isPartial && <Text style={s.receiptReminder}>Qolgan {quantityOf(remaining)} dona anjom qaytarilmaguncha, kunlik hisob davom etadi.</Text>}
      </View>}

      {(isPartial || isEdit) && returned.length > 0 && <View style={s.receiptGrand}><Text style={s.receiptGrandLabel}>{returnedOutstanding ? returnedPaid > 0 ? 'QISMAN TO‘LANDI · QOLDI' : 'TO‘LOV KUTILMOQDA' : 'QAYTARILGAN QISM TO‘LANDI'}</Text><Text style={[s.receiptGrandValue, { color: returnedOutstanding ? C.orange : C.successDark }]}>{formatMoney(returnedOutstanding || returnedTotal)}</Text></View>}
      {isFinal && (allPending ? <View style={s.receiptGrand}><Text style={s.receiptGrandLabel}>{allPaid > 0 ? 'QISMAN TO‘LANDI · QOLDI' : 'TO‘LOV KUTILMOQDA'}</Text><Text style={[s.receiptGrandValue, { color: C.orange }]}>{formatMoney(allPending)}</Text></View> : <View style={s.receiptGrand}><Text style={s.receiptGrandLabel}>TO‘LANDI</Text><Text style={[s.receiptGrandValue, { color: C.successDark }]}>{formatMoney(allPaid || final)}</Text></View>)}
      {!isPartial && !isFinal && <View style={s.receiptGrand}><Text style={s.receiptGrandLabel}>JORIY QARZ</Text><Text style={[s.receiptGrandValue, { color: C.redDark }]}>{formatMoney(current)}</Text></View>}
      {!isPartial && !isFinal && returned.length > 0 && <View style={[s.receiptGrand, { borderTopColor: allPending ? C.orange : C.success }]}><Text style={s.receiptGrandLabel}>{allPending ? allPaid > 0 ? 'QISMAN TO‘LANDI · QOLDI' : 'TO‘LOV KUTILMOQDA' : 'TO‘LANDI'}</Text><Text style={[s.receiptGrandValue, { color: allPending ? C.orange : C.successDark }]}>{formatMoney(allPending || allPaid)}</Text></View>}

      {activity.length > 0 && <View style={s.receiptActivity}><Text style={s.receiptSectionTitle}>AMALLAR TARIXI</Text>{activity.map((event) => <View key={event.id} style={s.receiptActivityRow}><Text style={s.receiptActivityTitle}>{activityTitle(event, true)}</Text><Text style={s.receiptItemSub}>{formatDate(event.createdAt, true)} · {event.actor || 'Admin'}</Text></View>)}</View>}
    </View>
    <View style={s.receiptActionGrid}><ReceiptAction icon="↓" label="PDF yuklab olish" primary busy={busy === 'pdf'} disabled={Boolean(busy)} onPress={() => run('pdf', onDownload)} /><ReceiptAction icon="▣" label="Chop etish" busy={busy === 'print'} disabled={Boolean(busy)} onPress={() => run('print', onPrint)} /><ReceiptAction icon="✉" label="SMS yuborish" orange busy={busy === 'sms'} disabled={Boolean(busy)} onPress={() => run('sms', onSms)} /></View>
    <View style={s.receiptRecordStack}>
      <Pressable disabled={Boolean(busy) || !returnableItems.length} style={({ pressed }) => [s.receiptRecordButton, s.receiptEditButton, (pressed || !returnableItems.length) && s.receiptRecordDisabled]} onPress={() => setRecordEditOpen(true)}><MaterialCommunityIcons name="pencil-outline" size={27} color={C.white} /><Text style={s.receiptEditButtonText}>Tahrirlash</Text></Pressable>
      <Pressable disabled={Boolean(busy) || !returnableItems.length} style={({ pressed }) => [s.receiptRecordButton, s.receiptReturnButton, (pressed || !returnableItems.length) && s.receiptRecordDisabled]} onPress={() => setReturnAllOpen(true)}><MaterialCommunityIcons name="package-check" size={27} color={C.orange} /><Text style={s.receiptReturnButtonText}>Hammasi qaytarildi</Text></Pressable>
      <Pressable disabled={Boolean(busy) || allPending <= 0} style={({ pressed }) => [s.receiptRecordButton, s.receiptPaidButton, (pressed || allPending <= 0) && s.receiptRecordDisabled]} onPress={() => setPaymentOpen(true)}><MaterialCommunityIcons name="cash-check" size={27} color={C.white} /><Text style={s.receiptPaidButtonText}>To‘landi</Text></Pressable>
    </View>
    <Text style={s.shareHint}>Birlamchi kanal: <Text style={{ fontWeight: '500', color: C.pageInk }}>{channel}</Text></Text><Pressable disabled={Boolean(busy)} style={s.shareButton} onPress={() => run('share', onShare)}><Text style={s.shareButtonText}>{busy === 'share' ? 'Tayyorlanmoqda...' : 'Boshqa ilovaga ulashish'}</Text></Pressable>
  </ScrollView></SafeAreaView>}</Modal><AllReturnConfirmModal open={returnAllOpen} rental={rental} onClose={() => setReturnAllOpen(false)} onSubmit={onReturn} /><PaymentReceiptModal open={paymentOpen} rental={rental} onClose={() => setPaymentOpen(false)} onSubmit={onPayment} /><RentalRecordEditModal open={recordEditOpen} rental={rental} equipment={equipment} onClose={() => setRecordEditOpen(false)} onSubmit={onRecordEdit} /></>;
}

function AllReturnConfirmModal({ open, rental, onClose, onSubmit }) {
  const items = rental ? openItems(rental) : [];
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (open) {
      setSaving(false);
      setError('');
    }
  }, [open, rental?.id]);
  const submit = async () => {
    if (saving) return;
    const returns = items.map((item) => ({ itemId: item.id, quantity: Number(item.quantity) }));
    if (!returns.length) {
      setError('Qaytariladigan ochiq anjom qolmagan.');
      return;
    }
    setSaving(true);
    setError('');
    const result = await onSubmit(rental, returns);
    setSaving(false);
    if (result?.ok) onClose();
    else setError(result?.error || 'Qaytarishni saqlab bo‘lmadi.');
  };
  return <Modal visible={Boolean(open && rental)} animationType="fade" transparent onRequestClose={onClose}><View style={s.paymentConfirmOverlay}>{rental && <View style={s.returnAllConfirmCard}>
    <View style={s.returnAllConfirmIcon}><MaterialCommunityIcons name="package-check" size={34} color={C.orange} /></View>
    <Text style={s.paymentConfirmTitle}>Rostdan ham barchasi qaytarildimi?</Text>
    <Text style={s.paymentConfirmText}>Tasdiqlansa, quyidagi barcha anjomlarning kunlik hisobi hozirgi sana va vaqtda to‘xtaydi.</Text>
    <View style={s.returnAllSummary}>{items.map((item) => <View key={item.id} style={s.returnAllSummaryRow}><Text style={s.returnAllSummaryName}>{item.name}</Text><Text style={s.returnAllSummaryQuantity}>{item.quantity} dona</Text></View>)}<View style={s.returnAllTotalRow}><Text style={s.returnAllTotalLabel}>JAMI QAYTADI</Text><Text style={s.returnAllTotalValue}>{quantityOf(items)} dona</Text></View></View>
    {error ? <View style={s.paymentConfirmError}><Text style={s.paymentConfirmErrorText}>{error}</Text></View> : null}
    <View style={s.paymentConfirmActions}><Pressable disabled={saving} style={s.paymentCancelButton} onPress={onClose}><Text style={s.paymentCancelText}>Yo‘q, bekor qilish</Text></Pressable><Pressable disabled={saving} style={[s.returnAllConfirmButton, saving && s.receiptRecordDisabled]} onPress={submit}>{saving ? <ActivityIndicator color={C.pageInk} /> : <Text style={s.returnAllConfirmButtonText}>Ha, hammasi qaytdi</Text>}</Pressable></View>
  </View>}</View></Modal>;
}

function PaymentReceiptModal({ open, rental, onClose, onSubmit }) {
  const maximum = rental ? pendingPaymentTotal(rental) : 0;
  const [amount, setAmount] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (open) {
      setAmount('');
      setSaving(false);
      setError('');
    }
  }, [open, rental?.id]);
  const submit = async () => {
    if (saving) return;
    const value = Number(amount);
    if (!Number.isSafeInteger(value) || value <= 0) {
      setError('To‘lov summasini kiriting.');
      return;
    }
    if (value > maximum) {
      setError(`To‘lov ${formatMoney(maximum)} dan oshmasligi kerak.`);
      return;
    }
    setSaving(true);
    setError('');
    const result = await onSubmit(rental, value);
    setSaving(false);
    if (result?.ok) onClose();
    else setError(result?.error || 'To‘lovni saqlab bo‘lmadi.');
  };
  const paymentHistory = (rental?.activity || []).filter((event) => event.type === 'payment');
  return <Modal visible={Boolean(open && rental)} animationType="slide" transparent onRequestClose={onClose}><View style={s.paymentConfirmOverlay}><KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={s.paymentEntryCard}>
    <View style={s.paymentEntryHead}><View style={s.paymentConfirmIcon}><MaterialCommunityIcons name="cash-check" size={32} color={C.successDark} /></View><Pressable style={s.paymentEntryClose} onPress={onClose}><Text style={s.closeText}>×</Text></Pressable></View>
    <Text style={s.paymentConfirmTitle}>To‘landi</Text><Text style={s.paymentConfirmText}>To‘liq yoki qisman olingan pul summasini kiriting.</Text>
    <View style={s.paymentPendingBox}><Text style={s.paymentPendingLabel}>TO‘LOV KUTILMOQDA</Text><Text style={s.paymentPendingValue}>{formatMoney(maximum)}</Text></View>
    <Field label="TO‘LANGAN SUMMA"><TextInput autoFocus style={s.input} value={amount} onChangeText={(value) => setAmount(value.replace(/[^0-9]/g, ''))} keyboardType="number-pad" placeholder="0" placeholderTextColor="#9AA49F" /></Field>
    <Pressable style={s.payAllButton} onPress={() => setAmount(String(maximum))}><Text style={s.payAllButtonText}>To‘liq summani kiritish</Text></Pressable>
    {paymentHistory.length > 0 && <Text style={s.paymentHistoryHint}>Oldingi to‘lovlar: {paymentHistory.length} ta · {formatMoney(paymentHistory.reduce((sum, event) => sum + Number(event.amount || 0), 0))}</Text>}
    {error ? <View style={s.paymentConfirmError}><Text style={s.paymentConfirmErrorText}>{error}</Text></View> : null}
    <View style={s.paymentConfirmActions}><Pressable disabled={saving} style={s.paymentCancelButton} onPress={onClose}><Text style={s.paymentCancelText}>Bekor qilish</Text></Pressable><Pressable disabled={saving} style={[s.paymentConfirmButton, saving && s.receiptRecordDisabled]} onPress={submit}>{saving ? <ActivityIndicator color={C.white} /> : <Text style={s.paymentConfirmButtonText}>To‘lovni saqlash</Text>}</Pressable></View>
  </KeyboardAvoidingView></View></Modal>;
}

function dateInputValue(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (number) => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function parseDateInput(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || '').trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day, 0, 0, 0, 0);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return date;
}

function RentalRecordEditModal({ open, rental, equipment, onClose, onSubmit }) {
  const activeItems = rental ? openItems(rental) : [];
  const returnedCount = rental ? returnedItems(rental).length : 0;
  const [rows, setRows] = useState([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const signature = activeItems.map((item) => `${item.id}:${item.quantity}:${item.dailyPrice}:${item.startedAt}:${item.equipmentTypeId}`).join('|');

  useEffect(() => {
    if (!open) return;
    setRows(activeItems.map((item) => ({
      id: item.id,
      originalStartedAt: item.startedAt || rental.startedAt,
      equipmentTypeId: item.equipmentTypeId || '',
      quantity: String(item.quantity),
      dailyPrice: String(item.dailyPrice),
      startedDate: dateInputValue(item.startedAt || rental.startedAt),
    })));
    setSaving(false);
    setError('');
  }, [open, rental?.id, signature]);

  const updateRow = (id, changes) => {
    setError('');
    setRows((current) => current.map((row) => row.id === id ? { ...row, ...changes } : row));
  };
  const currentByType = activeItems.reduce((map, item) => {
    if (item.equipmentTypeId) map[item.equipmentTypeId] = (map[item.equipmentTypeId] || 0) + Number(item.quantity || 0);
    return map;
  }, {});
  const capacityFor = (type) => Math.max(Number(type.availableQuantity || 0) + Number(currentByType[type.id] || 0), Number(currentByType[type.id] || 0));

  const submit = async () => {
    if (saving) return;
    const clean = [];
    for (const row of rows) {
      const quantity = Number(row.quantity);
      const dailyPrice = Number(row.dailyPrice);
      const selectedType = (equipment || []).find((item) => item.id === row.equipmentTypeId);
      const parsedDate = parseDateInput(row.startedDate);
      if (!selectedType) return setError('Har bir qatorda anjom turini tanlang.');
      if (!Number.isSafeInteger(quantity) || quantity <= 0) return setError(`${selectedType.name}: soni 1 yoki undan katta bo‘lishi kerak.`);
      if (!Number.isSafeInteger(dailyPrice) || dailyPrice < 0) return setError(`${selectedType.name}: kunlik narxni to‘g‘ri kiriting.`);
      if (!parsedDate) return setError(`${selectedType.name}: sanani YYYY-MM-DD ko‘rinishida kiriting.`);
      if (parsedDate.getTime() > Date.now()) return setError(`${selectedType.name}: olingan sana kelajakda bo‘lishi mumkin emas.`);
      const originalDate = dateInputValue(row.originalStartedAt);
      clean.push({
        id: row.id,
        equipmentTypeId: row.equipmentTypeId,
        quantity,
        dailyPrice,
        startedAt: row.startedDate === originalDate ? row.originalStartedAt : parsedDate.toISOString(),
      });
    }
    setSaving(true);
    setError('');
    const result = await onSubmit(rental, clean);
    setSaving(false);
    if (result?.ok) onClose();
    else setError(result?.error || 'O‘zgarishlarni saqlab bo‘lmadi.');
  };

  return <Modal visible={Boolean(open && rental)} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>{rental && <SafeAreaView style={s.modalPage}><KeyboardAvoidingView style={s.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}><ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={s.modalContent}>
    <ModalHeader title="Ijarani tahrirlash" subtitle={`${rental.customerName} · joriy anjomlar`} onClose={onClose} />
    <View style={s.editHistoryNotice}><MaterialCommunityIcons name="shield-check-outline" size={25} color={C.orange} /><Text style={s.editHistoryNoticeText}>Faqat hozir mijozdagi anjomlar tahrirlanadi. Qaytarilgan va to‘langan tarix o‘zgarmaydi{returnedCount ? ` (${returnedCount} ta tarixiy qator)` : ''}.</Text></View>
    {rows.map((row, index) => {
      const selectedType = (equipment || []).find((item) => item.id === row.equipmentTypeId);
      return <View key={row.id} style={s.recordEditCard}>
        <Text style={s.itemNumber}>ANJOM {index + 1}</Text>
        <Text style={s.recordEditLabel}>ANJOM TURI</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.suggestions}>{(equipment || []).map((type) => <Pressable key={type.id} onPress={() => updateRow(row.id, { equipmentTypeId: type.id, dailyPrice: String(type.dailyPrice) })} style={[s.suggestion, row.equipmentTypeId === type.id && s.suggestionActive]}><Text style={[s.suggestionText, row.equipmentTypeId === type.id && s.suggestionTextActive]}>{type.name} · {capacityFor(type)} ta</Text></Pressable>)}</ScrollView>
        {selectedType && <Text style={s.recordEditStock}>Ombor sig‘imi: bu ijara bilan birga {capacityFor(selectedType)} tagacha</Text>}
        <View style={s.twoColumns}><Field style={s.flex} label="SONI"><TextInput style={s.input} value={row.quantity} onChangeText={(value) => updateRow(row.id, { quantity: value.replace(/[^0-9]/g, '') })} keyboardType="number-pad" selectTextOnFocus /></Field><Field style={s.flex} label="KUNLIK NARX"><TextInput style={s.input} value={row.dailyPrice} onChangeText={(value) => updateRow(row.id, { dailyPrice: value.replace(/[^0-9]/g, '') })} keyboardType="number-pad" selectTextOnFocus /></Field></View>
        <Field label="OLINGAN SANA (YYYY-MM-DD)"><TextInput style={s.input} value={row.startedDate} onChangeText={(value) => updateRow(row.id, { startedDate: value.replace(/[^0-9-]/g, '').slice(0, 10) })} keyboardType="numbers-and-punctuation" placeholder="2026-08-05" placeholderTextColor="#9AA49F" /></Field>
      </View>;
    })}
    {error ? <View style={s.editSaveError}><MaterialCommunityIcons name="alert-circle-outline" size={24} color={C.redDark} /><Text style={s.editSaveErrorText}>{error}</Text></View> : null}
    <Pressable disabled={saving || !rows.length} style={[s.mainButton, (saving || !rows.length) && s.receiptRecordDisabled]} onPress={submit}>{saving ? <ActivityIndicator color={C.white} /> : <Text style={s.mainButtonText}>O‘zgarishlarni saqlash</Text>}</Pressable>
  </ScrollView></KeyboardAvoidingView></SafeAreaView>}</Modal>;
}

function ReceiptAction({ icon, label, onPress, primary, orange, busy, disabled }) {
  return <Pressable disabled={disabled} onPress={onPress} style={({ pressed }) => [s.receiptAction, primary && s.receiptActionPrimary, orange && s.receiptActionOrange, orange && { borderColor: C.blueLine, backgroundColor: C.blueSoft }, (pressed || disabled) && { opacity: .65 }]}>{busy ? <ActivityIndicator size="small" color={primary ? C.white : orange ? C.orange : C.green} /> : <Text style={[s.receiptActionIcon, primary && { color: C.white }, orange && { color: C.orange }]}>{icon}</Text>}<Text style={[s.receiptActionLabel, primary && { color: C.white }, orange && { color: C.orange }]}>{label}</Text></Pressable>;
}

function ModalHeader({ title, subtitle, onClose }) {
  return <View style={s.modalHeader}><View style={s.flex}><Text style={s.modalTitle}>{title}</Text><Text style={s.modalSub}>{subtitle}</Text></View><Pressable style={s.closeButton} onPress={onClose}><Text style={s.closeText}>×</Text></Pressable></View>;
}

function Field({ label, children, style }) {
  return <View style={[s.field, style]}><Text style={s.fieldLabel}>{label}</Text>{children}</View>;
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.page }, app: { flex: 1 }, flex: { flex: 1 },
  loader: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 18, backgroundColor: C.page },
  splash: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: C.page }, splashTitle: { color: C.pageInk, fontSize: 26, fontWeight: '500', marginTop: 16 }, splashSub: { color: C.pageMuted, fontSize: 20, fontWeight: '400', marginTop: 6 },
  logoFrame: { alignItems: 'center', justifyContent: 'center', backgroundColor: C.white, borderWidth: 1.5, borderColor: C.green, overflow: 'hidden' },
  screen: { flex: 1, backgroundColor: C.page }, screenContent: { paddingHorizontal: 16, paddingTop: Platform.OS === 'android' ? 16 : 8, paddingBottom: 200 },
  topBrand: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }, brand: { flexDirection: 'row', alignItems: 'center', gap: 10 }, brandName: { fontSize: 23.3, lineHeight: 26.6, fontWeight: '500', color: C.pageInk }, brandSub: { fontSize: 20, fontWeight: '400', color: C.pageMuted, letterSpacing: 1.1, marginTop: 2 },
  smallAdd: { width: 48, height: 48, borderRadius: 10, backgroundColor: C.green, alignItems: 'center', justifyContent: 'center' }, smallAddText: { color: C.white, fontSize: 33.8, fontWeight: '400', marginTop: -2 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }, headerTitle: { color: C.pageInk, fontSize: 32.5, fontWeight: '500', letterSpacing: -.3 }, headerSub: { color: C.pageMuted, fontSize: 20, fontWeight: '400', marginTop: 4, textTransform: 'capitalize' },
  metricGrid: { flexDirection: 'row', gap: 10, marginBottom: 12 }, metricCard: { flex: 1, minHeight: 120, padding: 16, borderRadius: 8, borderWidth: 1, borderColor: C.line, backgroundColor: C.card }, metricCardAmber: { backgroundColor: C.card, borderColor: C.blueLine }, metricLabel: { color: C.muted, fontSize: 20, fontWeight: '400', letterSpacing: .5 }, metricValue: { color: C.ink, fontSize: 32.5, fontWeight: '500', marginTop: 10 }, metricHint: { color: C.muted, fontSize: 20, fontWeight: '400', marginTop: 4 }, metricLabelAmber: { color: C.green2, fontSize: 20, fontWeight: '400', letterSpacing: .5 }, metricValueAmber: { color: C.green2, fontSize: 22.1, fontWeight: '500', marginTop: 13 }, metricHintAmber: { color: C.green2, fontSize: 20, fontWeight: '400', marginTop: 6 }, dashboardAddButton: { minHeight: 56, borderRadius: 8, backgroundColor: C.green, alignItems: 'center', justifyContent: 'center', marginBottom: 22 }, dashboardAddText: { color: C.white, fontSize: 20, fontWeight: '500' },
  sectionTitleRow: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 10 }, sectionTitle: { color: C.pageInk, fontSize: 22.1, fontWeight: '500' }, sectionSub: { color: C.pageMuted, fontSize: 20, fontWeight: '400', marginTop: 3 }, resultCount: { color: C.pageAccent, fontSize: 20, fontWeight: '500' }, searchBox: { height: 52, borderRadius: 8, borderWidth: 1, borderColor: C.line, backgroundColor: C.card, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, marginBottom: 12 }, searchIcon: { fontSize: 24.6, color: C.muted, marginRight: 7 }, searchInput: { flex: 1, height: '100%', fontSize: 20, fontWeight: '400', color: C.ink },
  rentalCard: { backgroundColor: C.card, borderRadius: 8, borderWidth: 1, borderLeftWidth: 4, borderColor: C.line, padding: 16 }, pressed: { opacity: .72 }, customerRow: { flexDirection: 'row', alignItems: 'center' }, avatar: { width: 42, height: 42, borderRadius: 21, backgroundColor: C.greenSoft, alignItems: 'center', justifyContent: 'center', marginRight: 10 }, avatarText: { color: C.green2, fontWeight: '500', fontSize: 20 }, customerName: { color: C.ink, fontSize: 20, fontWeight: '500' }, phone: { color: C.muted, fontSize: 20, fontWeight: '400', marginTop: 3 }, arrow: { color: C.muted, fontSize: 28.6 }, cardAmount: { alignItems: 'flex-end', marginLeft: 8 }, cardAmountLabel: { color: C.muted, fontSize: 20, fontWeight: '400', letterSpacing: .4 }, cardAmountValue: { fontSize: 20, fontWeight: '500', marginTop: 4 }, cardDivider: { height: 1, backgroundColor: C.line, marginVertical: 12 }, rentalMeta: { flexDirection: 'row' }, meta: { flex: 1 }, metaLabel: { color: C.muted, fontSize: 20, fontWeight: '400', letterSpacing: .4, marginBottom: 4 }, metaValue: { color: C.ink, fontSize: 20, fontWeight: '400' }, cardPaidNote: { marginTop: 10, paddingTop: 9, borderTopWidth: 1, borderTopColor: C.line }, cardPaidNoteText: { color: C.green2, fontSize: 20, fontWeight: '400' },
  customerListCard: { minHeight: 78, padding: 15, backgroundColor: C.card, borderRadius: 8, borderWidth: 1, borderColor: C.line, flexDirection: 'row', alignItems: 'center' }, customerDebt: { color: C.green2, fontSize: 20, fontWeight: '500', marginLeft: 8 },
  backLink: { alignSelf: 'flex-start', marginBottom: 12 }, backLinkText: { color: C.pageAccent, fontSize: 20, fontWeight: '500' }, inventoryTable: { backgroundColor: C.card, borderRadius: 8, borderWidth: 1, borderColor: C.line, overflow: 'hidden' }, inventoryHeader: { minHeight: 46, backgroundColor: C.cardRaised, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12 }, inventoryHeaderText: { color: C.green2, fontSize: 20, fontWeight: '400', letterSpacing: .4 }, inventoryRow: { minHeight: 52, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, borderTopWidth: 1, borderTopColor: C.line }, inventoryCellName: { flex: 1.5, color: C.ink, fontSize: 20, fontWeight: '400' }, inventoryCell: { flex: 1, color: C.muted, fontSize: 20, fontWeight: '400', textAlign: 'right' }, inventoryLink: { minHeight: 78, padding: 16, backgroundColor: C.card, borderRadius: 8, borderWidth: 1, borderColor: C.line, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }, inventoryArrow: { color: C.green2, fontSize: 31.1, fontWeight: '400' },
  inventoryTopRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 2 }, inventoryBackButton: { width: 40, height: 40, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: C.card, borderWidth: 1, borderColor: C.line }, inventoryBackText: { color: C.green2, fontSize: 29.8, lineHeight: 31.6, fontWeight: '400', marginTop: -2 }, inventoryTitle: { color: C.pageInk, fontSize: 27.3, fontWeight: '500' }, inventorySubtitle: { color: C.pageMuted, fontSize: 20, fontWeight: '400', marginBottom: 12 }, inventoryMetricGrid: { flexDirection: 'row', gap: 8, marginBottom: 9 }, inventoryMetricCard: { flex: 1, minHeight: 96, padding: 15, borderRadius: 8, borderWidth: 1, borderColor: C.line, backgroundColor: C.card }, inventoryMetricCardAmber: { backgroundColor: C.card, borderColor: C.blueLine }, inventoryMetricLabel: { color: C.muted, fontSize: 20, fontWeight: '400', letterSpacing: .4 }, inventoryMetricValue: { color: C.ink, fontSize: 28.6, fontWeight: '500', marginTop: 7 }, inventoryMetricHint: { color: C.muted, fontSize: 20, fontWeight: '400', marginTop: 3 }, inventoryMetricLabelAmber: { color: C.green2, fontSize: 20, fontWeight: '400', letterSpacing: .4 }, inventoryMetricValueAmber: { color: C.green2, fontSize: 28.6, fontWeight: '500', marginTop: 7 }, inventoryMetricHintAmber: { color: C.green2, fontSize: 20, fontWeight: '400', marginTop: 3 }, inventoryAddButton: { minHeight: 54, borderRadius: 8, backgroundColor: C.green, alignItems: 'center', justifyContent: 'center', marginBottom: 14 }, inventoryAddText: { color: C.white, fontSize: 20, fontWeight: '500' }, inventoryCard: { backgroundColor: C.card, borderRadius: 8, borderWidth: 1, borderColor: C.line, padding: 16, marginBottom: 8 }, inventoryCardDepleted: { borderColor: C.line, borderLeftWidth: 3, borderLeftColor: C.red }, inventoryCardTop: { flexDirection: 'row', alignItems: 'flex-start' }, inventoryName: { color: C.ink, fontSize: 20, fontWeight: '500' }, inventoryDaily: { color: C.muted, fontSize: 20, fontWeight: '400', marginTop: 4 }, inventoryMenuButton: { width: 36, height: 34, alignItems: 'center', justifyContent: 'center' }, inventoryMenuText: { color: C.muted, fontSize: 20.8, letterSpacing: 1 }, inventoryStats: { flexDirection: 'row', gap: 8, paddingTop: 10, marginTop: 10, borderTopWidth: 1, borderTopColor: C.line }, inventoryStat: { flex: 1 }, inventoryStatLabel: { color: C.muted, fontSize: 20, fontWeight: '400', letterSpacing: .45, marginBottom: 3 }, inventoryStatValue: { color: C.ink, fontSize: 20.8, fontWeight: '500' }, inventoryStatValueAvailable: { color: C.successDark, fontSize: 20.8, fontWeight: '500' }, inventoryStatValueDepleted: { color: C.redDark, fontSize: 20.8, fontWeight: '500' }, inventoryAvailableRow: { flexDirection: 'row', alignItems: 'baseline', gap: 6 }, inventoryUnavailable: { color: C.redDark, fontSize: 20, fontWeight: '400' }, inventoryStockStatus: { alignSelf: 'flex-start', borderRadius: 8, paddingVertical: 5, paddingHorizontal: 9, marginTop: 13 }, inventoryStockAvailable: { backgroundColor: '#14351F' }, inventoryStockDepleted: { backgroundColor: C.redSoft }, inventoryStockStatusText: { color: C.successDark, fontSize: 20, fontWeight: '500', letterSpacing: .5 }, inventoryMenuRow: { flexDirection: 'row', gap: 8, marginTop: 10, paddingTop: 8, borderTopWidth: 1, borderTopColor: C.line }, inventoryMenuAction: { flex: 1, minHeight: 44, borderRadius: 8, backgroundColor: C.cardRaised, borderWidth: 1, borderColor: C.line, alignItems: 'center', justifyContent: 'center' }, inventoryMenuActionDanger: { flex: 1, minHeight: 44, borderRadius: 8, backgroundColor: C.redSoft, borderWidth: 1, borderColor: C.redLine, alignItems: 'center', justifyContent: 'center' }, inventoryMenuActionText: { color: C.ink, fontSize: 20, fontWeight: '400' }, inventoryMenuActionDangerText: { color: C.redDark, fontSize: 20, fontWeight: '400' }, equipmentModalHint: { color: C.pageMuted, fontSize: 20, fontWeight: '400', lineHeight: 24, marginTop: -2, marginBottom: 18 }, deleteConfirmText: { color: C.pageInk, fontSize: 20, fontWeight: '400', lineHeight: 27.8, marginBottom: 10 }, deleteErrorBox: { borderWidth: 1, borderColor: C.redLine, borderRadius: 8, backgroundColor: C.redSoft, padding: 12, marginBottom: 15 }, deleteErrorText: { color: C.redDark, fontSize: 20, fontWeight: '400', lineHeight: 24 }, deleteActions: { flexDirection: 'row', gap: 8, marginTop: 8 }, deleteCancelButton: { flex: 1, minHeight: 52, borderRadius: 8, borderWidth: 1, borderColor: C.line, backgroundColor: C.card, alignItems: 'center', justifyContent: 'center' }, deleteCancelText: { color: C.ink, fontSize: 20, fontWeight: '400' }, deleteConfirmButton: { flex: 1, minHeight: 52, borderRadius: 8, backgroundColor: C.red, alignItems: 'center', justifyContent: 'center' }, deleteConfirmTextButton: { color: C.white, fontSize: 20, fontWeight: '500' },
  historyCard: { padding: 14, backgroundColor: C.card, borderRadius: 8, borderWidth: 1, borderColor: C.line }, historyTop: { flexDirection: 'row', alignItems: 'center' }, doneBadge: { borderRadius: 8, backgroundColor: C.greenSoft, paddingHorizontal: 8, paddingVertical: 5 }, doneText: { fontSize: 20, color: C.green2, fontWeight: '400' }, historyBottom: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }, historyItems: { color: C.muted, fontSize: 20, fontWeight: '400' }, historyTotal: { color: C.ink, fontWeight: '500', fontSize: 20 },
  empty: { alignItems: 'center', justifyContent: 'center', paddingVertical: 50, paddingHorizontal: 28 }, emptyIcon: { width: 54, height: 54, borderRadius: 27, backgroundColor: C.card, alignItems: 'center', justifyContent: 'center', marginBottom: 13 }, emptyIconText: { fontSize: 29.8, color: C.green2 }, emptyTitle: { color: C.pageInk, fontWeight: '500', fontSize: 20.8 }, emptyText: { color: C.pageMuted, fontSize: 20, fontWeight: '400', textAlign: 'center', lineHeight: 24, marginTop: 6 }, emptyButton: { backgroundColor: C.green, paddingHorizontal: 18, paddingVertical: 11, borderRadius: 8, marginTop: 16 }, emptyButtonText: { color: C.white, fontWeight: '500', fontSize: 20 },
  settingsCard: { backgroundColor: C.card, borderWidth: 1, borderColor: C.line, borderRadius: 8, padding: 18, marginBottom: 12 }, settingsTitle: { fontSize: 20, fontWeight: '500', color: C.ink }, settingsText: { fontSize: 20, color: C.muted, fontWeight: '400', lineHeight: 24, marginTop: 6, marginBottom: 14 }, channelGrid: { flexDirection: 'row', gap: 8 }, channel: { flex: 1, borderWidth: 1, borderColor: C.line, backgroundColor: C.cardRaised, paddingVertical: 14, borderRadius: 8, alignItems: 'center' }, channelActive: { backgroundColor: C.green, borderColor: C.green }, channelText: { color: C.muted, fontSize: 20, fontWeight: '400' }, channelTextActive: { color: C.white }, infoRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: C.line }, infoLabel: { color: C.muted, fontSize: 20, fontWeight: '400' }, infoValue: { color: C.ink, fontSize: 20, fontWeight: '400', maxWidth: '62%', textAlign: 'right' }, note: { borderRadius: 8, padding: 14, backgroundColor: C.card }, noteTitle: { color: C.green2, fontWeight: '500', fontSize: 20 }, noteText: { color: C.muted, fontSize: 20, fontWeight: '400', lineHeight: 24, marginTop: 5 },
  pendingPanel: { backgroundColor: C.card, borderWidth: 1, borderColor: C.blueLine, borderRadius: 8, padding: 14, marginBottom: 18 }, pendingPanelHead: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }, pendingPanelTitle: { color: C.green2, fontSize: 22, fontWeight: '500' }, pendingPanelSub: { color: C.muted, fontSize: 20, lineHeight: 25, marginTop: 4 }, pendingPanelTotal: { color: C.green2, fontSize: 22, fontWeight: '500' }, pendingPanelRow: { flexDirection: 'row', alignItems: 'center', borderTopWidth: 1, borderTopColor: C.blueLine, paddingTop: 10, marginTop: 10, gap: 10 }, pendingPanelAmount: { color: C.green2, fontSize: 20, fontWeight: '500' }, pendingPanelAction: { minHeight: 52, borderRadius: 8, backgroundColor: C.green, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginTop: 14, paddingHorizontal: 16 }, pendingPanelActionText: { color: C.white, fontSize: 20, fontWeight: '500' }, pendingPanelActionArrow: { color: C.white, fontSize: 30, fontWeight: '400', marginLeft: 8, marginTop: -2 },
  pendingPaymentCard: { backgroundColor: C.card, borderColor: C.blueLine }, pendingPaymentFooter: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginTop: 9 }, paidConfirmButton: { borderRadius: 8, backgroundColor: C.success, paddingHorizontal: 15, paddingVertical: 10 }, paidConfirmText: { color: C.white, fontSize: 20, fontWeight: '500' },
  paymentMenuLinkActive: { borderColor: C.blueLine, backgroundColor: C.card }, paymentMenuIcon: { width: 48, height: 48, borderRadius: 8, backgroundColor: C.cardRaised, borderWidth: 1, borderColor: C.blueLine, alignItems: 'center', justifyContent: 'center', marginRight: 12 }, paymentMenuBadge: { minWidth: 34, height: 34, borderRadius: 17, backgroundColor: C.red, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 7, marginLeft: 8 }, paymentMenuBadgeText: { color: C.white, fontSize: 20, fontWeight: '500' },
  paymentMetricGrid: { flexDirection: 'row', gap: 10, marginBottom: 14 }, paymentMetricCard: { flex: 1, minHeight: 126, padding: 15, borderRadius: 8, borderWidth: 1, borderColor: C.line, backgroundColor: C.card }, paymentMetricTotalCard: { backgroundColor: C.card, borderColor: C.blueLine }, paymentMetricLabel: { color: C.muted, fontSize: 20, lineHeight: 24, fontWeight: '400' }, paymentMetricCount: { color: C.ink, fontSize: 32, fontWeight: '500', marginTop: 8 }, paymentMetricTotal: { color: C.green2, fontSize: 22, fontWeight: '500', marginTop: 8 }, paymentMetricHint: { color: C.muted, fontSize: 20, lineHeight: 24, fontWeight: '400', marginTop: 4 }, paymentLoading: { minHeight: 54, borderRadius: 8, borderWidth: 1, borderColor: C.blueLine, backgroundColor: C.card, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, marginBottom: 12 }, paymentLoadingText: { color: C.green2, fontSize: 20, fontWeight: '400' },
  paymentGroupCard: { backgroundColor: C.card, borderRadius: 8, borderWidth: 1, borderColor: C.line, padding: 16, marginBottom: 12 }, paymentCustomerHead: { flexDirection: 'row', alignItems: 'center', paddingBottom: 13 }, paymentCustomerButton: { minHeight: 44, borderRadius: 8, borderWidth: 1, borderColor: C.blueLine, backgroundColor: C.cardRaised, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 13, marginLeft: 8 }, paymentCustomerButtonText: { color: C.green2, fontSize: 20, fontWeight: '500' }, paymentItemRow: { borderTopWidth: 1, borderTopColor: C.line, paddingTop: 14, marginTop: 2 }, paymentItemTop: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 }, paymentItemName: { color: C.ink, fontSize: 20, fontWeight: '500' }, paymentItemMeta: { color: C.muted, fontSize: 20, lineHeight: 25, fontWeight: '400', marginTop: 4 }, paymentItemAmount: { color: C.redDark, fontSize: 20, fontWeight: '500', textAlign: 'right' }, paymentApproveButton: { minHeight: 50, borderRadius: 8, backgroundColor: C.success, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 12, marginBottom: 14, paddingHorizontal: 14 }, paymentApproveText: { color: C.white, fontSize: 20, fontWeight: '500' },
  paymentConfirmOverlay: { flex: 1, backgroundColor: 'rgba(17,24,39,.52)', alignItems: 'center', justifyContent: 'center', padding: 20 }, paymentConfirmCard: { width: '100%', maxWidth: 460, backgroundColor: C.card, borderRadius: 10, borderWidth: 1, borderColor: C.line, padding: 20 }, paymentConfirmIcon: { width: 58, height: 58, borderRadius: 12, backgroundColor: '#14351F', alignItems: 'center', justifyContent: 'center', marginBottom: 14 }, paymentConfirmTitle: { color: C.ink, fontSize: 25, fontWeight: '500' }, paymentConfirmText: { color: C.muted, fontSize: 20, lineHeight: 26, fontWeight: '400', marginTop: 8 }, paymentConfirmSummary: { borderRadius: 8, borderWidth: 1, borderColor: C.blueLine, backgroundColor: C.cardRaised, padding: 14, marginTop: 16 }, paymentConfirmCustomer: { color: C.ink, fontSize: 20, fontWeight: '500' }, paymentConfirmItem: { color: C.muted, fontSize: 20, lineHeight: 25, fontWeight: '400', marginTop: 5 }, paymentConfirmAmount: { color: C.redDark, fontSize: 24, fontWeight: '500', marginTop: 8 }, paymentConfirmError: { borderRadius: 8, borderWidth: 1, borderColor: C.redLine, backgroundColor: C.redSoft, padding: 12, marginTop: 12 }, paymentConfirmErrorText: { color: C.redDark, fontSize: 20, lineHeight: 25, fontWeight: '400' }, paymentConfirmActions: { flexDirection: 'row', gap: 10, marginTop: 18 }, paymentCancelButton: { flex: 1, minHeight: 54, borderRadius: 8, borderWidth: 1, borderColor: C.line, backgroundColor: C.cardRaised, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12 }, paymentCancelText: { color: C.ink, fontSize: 20, fontWeight: '400' }, paymentConfirmButton: { flex: 1, minHeight: 54, borderRadius: 8, backgroundColor: C.success, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12 }, paymentConfirmButtonText: { color: C.white, fontSize: 20, fontWeight: '500', textAlign: 'center' }, paymentButtonDisabled: { opacity: .6 },
  smsQueueCard: { backgroundColor: C.card, borderWidth: 1, borderColor: C.line, borderRadius: 8, padding: 14, marginTop: 10 }, smsQueueHead: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 }, smsQueueStatus: { fontSize: 20, fontWeight: '500', letterSpacing: .3 }, smsQueueMessage: { color: C.ink, fontSize: 20, lineHeight: 26, marginTop: 10 }, smsQueueError: { color: C.redDark, fontSize: 20, lineHeight: 25, marginTop: 8 }, smsQueueSend: { alignSelf: 'flex-start', borderRadius: 8, backgroundColor: C.green, paddingHorizontal: 16, paddingVertical: 10, marginTop: 12 }, smsQueueSendText: { color: C.white, fontSize: 20, fontWeight: '500' },
  bottomNav: { position: 'absolute', left: 12, right: 12, bottom: Platform.OS === 'ios' ? 10 : 12, height: 98, borderRadius: 8, backgroundColor: C.card, borderWidth: 1, borderColor: C.line, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-around', paddingHorizontal: 4, shadowColor: '#000000', shadowOpacity: .18, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 3 }, navButton: { flex: 1, minHeight: 82, alignItems: 'center', justifyContent: 'center', gap: 3, paddingVertical: 7, paddingHorizontal: 2, borderRadius: 8 }, navButtonActive: { backgroundColor: C.cardRaised }, navIconWrap: { width: 44, height: 38, borderRadius: 8, alignItems: 'center', justifyContent: 'center' }, navIconWrapActive: { backgroundColor: C.blueSoft }, navIcon: { color: C.muted, fontSize: 31.1 }, navLabel: { color: C.muted, fontSize: 20, fontWeight: '400', textAlign: 'center' }, navActive: { color: C.green2, fontWeight: '500' },
  modalPage: { flex: 1, backgroundColor: C.page }, modalContent: { padding: 20, paddingBottom: 42 }, modalHeader: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 20 }, modalTitle: { color: C.pageInk, fontSize: 28.6, fontWeight: '500' }, modalSub: { color: C.pageMuted, fontSize: 20, fontWeight: '400', marginTop: 4 }, closeButton: { width: 42, height: 42, borderRadius: 8, backgroundColor: C.card, alignItems: 'center', justifyContent: 'center' }, closeText: { color: C.white, fontSize: 28.6, fontWeight: '400', marginTop: -2 }, field: { marginBottom: 14, backgroundColor: C.card, borderRadius: 8, padding: 8 }, fieldLabel: { color: C.muted, fontSize: 20, fontWeight: '500', letterSpacing: .7, marginBottom: 7 }, input: { height: 56, backgroundColor: C.cardRaised, borderWidth: 1, borderColor: C.line, borderRadius: 8, paddingHorizontal: 16, fontSize: 20, fontWeight: '400', color: C.ink }, itemsHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 5, marginBottom: 10 }, itemsTitle: { fontSize: 20.8, fontWeight: '500', color: C.pageInk }, itemsCount: { color: C.pageMuted, fontSize: 20, fontWeight: '400' }, itemEditor: { backgroundColor: C.card, borderWidth: 1, borderColor: C.line, borderRadius: 8, padding: 16, marginBottom: 9 }, itemEditorTop: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 9 }, itemNumber: { color: C.green2, fontSize: 20, fontWeight: '400', letterSpacing: .7 }, removeText: { color: C.redDark, fontSize: 20, fontWeight: '400' }, suggestions: { gap: 6, paddingVertical: 8 }, suggestion: { borderRadius: 8, paddingVertical: 6, paddingHorizontal: 10, backgroundColor: C.cardRaised, borderWidth: 1, borderColor: C.line }, suggestionActive: { backgroundColor: C.blueSoft, borderColor: C.blueLine }, suggestionText: { fontSize: 20, color: C.muted, fontWeight: '400' }, suggestionTextActive: { color: C.green2 }, twoColumns: { flexDirection: 'row', gap: 10, marginTop: 2 }, addItem: { height: 52, borderRadius: 8, borderWidth: 1, borderColor: C.line, backgroundColor: C.card, alignItems: 'center', justifyContent: 'center', marginBottom: 14 }, addItemText: { color: C.white, fontSize: 20, fontWeight: '500' }, dailyTotal: { padding: 14, borderRadius: 8, backgroundColor: C.card, borderWidth: 1, borderColor: C.blueLine, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }, dailyLabel: { color: C.muted, fontSize: 20, fontWeight: '400' }, dailyValue: { color: C.green2, fontSize: 20.8, fontWeight: '500' }, mainButton: { minHeight: 56, backgroundColor: C.green, borderRadius: 8, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 18 }, mainButtonText: { color: C.white, fontSize: 20, fontWeight: '500' },
  detailSummary: { backgroundColor: C.card, borderWidth: 1, borderColor: C.blueLine, borderRadius: 8, padding: 20, marginBottom: 18 }, detailLabel: { color: C.green2, fontSize: 20, letterSpacing: 1, fontWeight: '400' }, detailTotal: { color: C.green2, fontSize: 35.1, fontWeight: '500', marginTop: 6 }, detailDate: { color: C.muted, fontSize: 20, fontWeight: '400', marginTop: 8 }, detailSectionHeader: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', marginTop: 4, marginBottom: 1 }, detailSectionCount: { color: C.pageMuted, fontSize: 20, fontWeight: '400' }, paidSectionTotal: { color: C.pageAccent, fontSize: 20, fontWeight: '500' }, detailItem: { backgroundColor: C.card, borderWidth: 1, borderColor: C.line, borderRadius: 8, padding: 16, marginTop: 8 }, detailItemTop: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 }, detailItemName: { color: C.ink, fontSize: 20, fontWeight: '500' }, detailItemSub: { color: C.muted, fontSize: 20, fontWeight: '400', marginTop: 4 }, detailItemTotal: { color: C.green2, fontSize: 20, fontWeight: '400' }, returnButton: { borderRadius: 8, backgroundColor: C.green, alignItems: 'center', paddingVertical: 15, marginTop: 12 }, returnButtonText: { color: C.white, fontWeight: '500', fontSize: 20 }, returnHistoryItem: { backgroundColor: C.cardRaised, borderWidth: 1, borderColor: C.line, borderRadius: 8, padding: 13, marginTop: 8 }, returnHistoryAmount: { color: C.green2, fontSize: 20, fontWeight: '400' }, paidBadge: { alignSelf: 'flex-start', borderRadius: 8, backgroundColor: C.greenSoft, paddingHorizontal: 8, paddingVertical: 4, marginTop: 9 }, paidBadgeText: { color: C.green2, fontSize: 20, fontWeight: '400', letterSpacing: .4 }, receiptButton: { borderRadius: 8, borderWidth: 1, borderColor: C.pageAccent, alignItems: 'center', paddingVertical: 12, marginTop: 15 }, receiptButtonText: { color: C.pageAccent, fontWeight: '500', fontSize: 20 },
  overlay: { flex: 1, backgroundColor: 'rgba(17,24,39,.48)', justifyContent: 'flex-end' }, returnSheet: { maxHeight: '89%', backgroundColor: C.page, padding: 18, paddingBottom: Platform.OS === 'ios' ? 32 : 20, borderTopLeftRadius: 8, borderTopRightRadius: 8 }, returnHint: { fontSize: 20, lineHeight: 24, color: C.pageMuted, fontWeight: '400', marginBottom: 12 }, returnItemsScroll: { flexGrow: 0, marginBottom: 13 }, returnItemsList: { gap: 8 }, returnItemCard: { backgroundColor: C.card, borderRadius: 8, borderWidth: 1, borderColor: C.line, padding: 16 }, returnItemHeading: { flexDirection: 'row', gap: 10, alignItems: 'flex-start', marginBottom: 9 }, returnItemMeta: { color: C.muted, fontSize: 20, fontWeight: '400', marginTop: 4 }, returnMax: { color: C.green2, fontSize: 20, fontWeight: '400' },
  editSaveError: { flexDirection: 'row', alignItems: 'flex-start', gap: 9, borderWidth: 1, borderColor: C.redLine, backgroundColor: C.redSoft, borderRadius: 12, padding: 12, marginBottom: 10 }, editSaveErrorText: { flex: 1, color: C.redDark, fontSize: 20, lineHeight: 25, fontWeight: '400' },
  activityCard: { backgroundColor: C.card, borderWidth: 1, borderColor: C.line, borderRadius: 8, paddingHorizontal: 14, marginTop: 8, marginBottom: 12 }, activityRow: { flexDirection: 'row', alignItems: 'center', gap: 11, paddingVertical: 13, borderBottomWidth: 1, borderBottomColor: C.line }, activityIcon: { width: 42, height: 42, borderRadius: 8, alignItems: 'center', justifyContent: 'center' }, activityIconPayment: { backgroundColor: '#14351F' }, activityIconReturn: { backgroundColor: '#382E0B' }, activityIconEdit: { backgroundColor: C.blueSoft }, activityTitle: { color: C.ink, fontSize: 20, fontWeight: '500' }, activityMeta: { color: C.muted, fontSize: 20, fontWeight: '400', marginTop: 3 },
  receiptActivity: { marginTop: 16, paddingTop: 12, borderTopWidth: 1, borderTopColor: C.line }, receiptActivityRow: { paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: C.line }, receiptActivityTitle: { color: C.ink, fontSize: 20, fontWeight: '500' },
  receiptRecordStack: { gap: 9, marginBottom: 14 }, detailRecordStack: { marginTop: 14, marginBottom: 0 }, receiptRecordButton: { width: '100%', minHeight: 62, borderRadius: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, paddingHorizontal: 14 }, receiptReturnButton: { backgroundColor: C.card, borderWidth: 1, borderColor: C.orange }, receiptReturnButtonText: { color: C.orange, fontSize: 20, fontWeight: '500', textAlign: 'center' }, receiptPaidButton: { backgroundColor: C.success, borderWidth: 1, borderColor: C.success }, receiptPaidButtonText: { color: C.white, fontSize: 20, fontWeight: '500', textAlign: 'center' }, receiptEditButton: { backgroundColor: C.green, borderWidth: 1, borderColor: C.green }, receiptEditButtonText: { color: C.white, fontSize: 20, fontWeight: '500', textAlign: 'center' }, receiptRecordDisabled: { opacity: .45 },
  editHistoryNotice: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, borderRadius: 8, borderWidth: 1, borderColor: C.orange, backgroundColor: C.card, padding: 14, marginBottom: 12 }, editHistoryNoticeText: { flex: 1, color: C.ink, fontSize: 20, lineHeight: 25, fontWeight: '400' }, recordEditCard: { backgroundColor: C.card, borderWidth: 1, borderColor: C.line, borderRadius: 8, padding: 16, marginBottom: 10 }, recordEditLabel: { color: C.muted, fontSize: 20, fontWeight: '500', letterSpacing: .7, marginTop: 10 }, recordEditStock: { color: C.green2, fontSize: 20, lineHeight: 24, marginBottom: 8 },
  returnAllConfirmCard: { width: '100%', maxWidth: 500, maxHeight: '88%', backgroundColor: C.card, borderRadius: 10, borderWidth: 1, borderColor: C.orange, padding: 20 }, returnAllConfirmIcon: { width: 60, height: 60, borderRadius: 10, backgroundColor: '#382E0B', alignItems: 'center', justifyContent: 'center', marginBottom: 14 }, returnAllSummary: { backgroundColor: C.cardRaised, borderWidth: 1, borderColor: C.line, borderRadius: 8, paddingHorizontal: 14, marginTop: 16 }, returnAllSummaryRow: { minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, borderBottomWidth: 1, borderBottomColor: C.line }, returnAllSummaryName: { flex: 1, color: C.ink, fontSize: 20, fontWeight: '400' }, returnAllSummaryQuantity: { color: C.orange, fontSize: 20, fontWeight: '500' }, returnAllTotalRow: { minHeight: 54, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }, returnAllTotalLabel: { color: C.muted, fontSize: 20, fontWeight: '500' }, returnAllTotalValue: { color: C.orange, fontSize: 22, fontWeight: '500' }, returnAllConfirmButton: { flex: 1, minHeight: 54, borderRadius: 8, backgroundColor: C.page, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 10 }, returnAllConfirmButtonText: { color: C.pageInk, fontSize: 20, fontWeight: '500', textAlign: 'center' },
  paymentEntryCard: { width: '100%', maxWidth: 470, backgroundColor: C.card, borderRadius: 10, borderWidth: 1, borderColor: C.line, padding: 20 }, paymentEntryHead: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' }, paymentEntryClose: { width: 42, height: 42, borderRadius: 8, backgroundColor: C.cardRaised, alignItems: 'center', justifyContent: 'center' }, paymentPendingBox: { backgroundColor: C.cardRaised, borderWidth: 1, borderColor: C.orange, borderRadius: 8, padding: 14, marginVertical: 16 }, paymentPendingLabel: { color: C.orange, fontSize: 20, fontWeight: '400' }, paymentPendingValue: { color: C.orange, fontSize: 26, fontWeight: '500', marginTop: 6 }, payAllButton: { minHeight: 48, borderRadius: 8, borderWidth: 1, borderColor: C.success, backgroundColor: '#14351F', alignItems: 'center', justifyContent: 'center', marginTop: -4 }, payAllButtonText: { color: C.successDark, fontSize: 20, fontWeight: '500' }, paymentHistoryHint: { color: C.muted, fontSize: 20, lineHeight: 25, marginTop: 12 },
  receiptPaper: { backgroundColor: C.card, borderWidth: 1, borderColor: C.line, borderRadius: 8, padding: 18, marginBottom: 13 }, receiptHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingBottom: 14, borderBottomWidth: 1, borderStyle: 'dashed', borderBottomColor: C.line }, receiptNumber: { color: C.muted, fontSize: 20, fontWeight: '400' }, receiptCustomer: { alignItems: 'center', paddingVertical: 17 }, receiptName: { color: C.ink, fontSize: 20, fontWeight: '500' }, receiptDate: { color: C.muted, fontSize: 20, fontWeight: '400', marginTop: 7 }, receiptSectionTitle: { color: C.green2, fontSize: 20, letterSpacing: .8, fontWeight: '400', marginBottom: 2 }, receiptRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 11, borderTopWidth: 1, borderTopColor: C.line }, receiptItemName: { color: C.ink, fontSize: 20, fontWeight: '400' }, receiptItemSub: { color: C.muted, fontSize: 20, fontWeight: '400', marginTop: 4 }, receiptPaidAmount: { color: C.green2, fontWeight: '400', fontSize: 20 }, receiptCurrentBlock: { marginTop: 12, backgroundColor: C.cardRaised, borderRadius: 8, padding: 12, borderWidth: 1, borderColor: C.blueLine }, receiptCurrentTitle: { color: C.green2, fontSize: 20, letterSpacing: .45, fontWeight: '400', marginBottom: 7 }, receiptOpenRow: { paddingVertical: 8, borderTopWidth: 1, borderTopColor: C.line }, receiptOpenAmount: { color: C.green2, fontWeight: '400', fontSize: 20 }, receiptCurrentTotal: { color: C.green2, fontWeight: '500', fontSize: 20.8, textAlign: 'right', paddingTop: 8, marginTop: 4, borderTopWidth: 1, borderTopColor: C.blueLine }, receiptReminder: { color: C.muted, fontSize: 20, fontWeight: '400', lineHeight: 24, marginTop: 10 }, receiptGrand: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 15, marginTop: 13, borderTopWidth: 1, borderTopColor: C.ink }, receiptGrandLabel: { color: C.ink, fontSize: 20, fontWeight: '500', maxWidth: '56%' }, receiptGrandValue: { color: C.green2, fontSize: 23.3, fontWeight: '500' }, receiptActionGrid: { flexDirection: 'row', gap: 8, marginBottom: 13 }, receiptAction: { flex: 1, minHeight: 78, paddingVertical: 11, paddingHorizontal: 8, borderWidth: 1, borderColor: C.blueLine, borderRadius: 8, alignItems: 'center', justifyContent: 'center', gap: 5, backgroundColor: C.card }, receiptActionPrimary: { backgroundColor: C.green, borderColor: C.green }, receiptActionOrange: { borderColor: C.blueLine, backgroundColor: C.card }, receiptActionIcon: { color: C.green2, fontSize: 22.1, fontWeight: '400' }, receiptActionLabel: { color: C.green2, fontSize: 20, textAlign: 'center', fontWeight: '400' }, shareHint: { textAlign: 'center', color: C.pageMuted, fontSize: 20, fontWeight: '400', marginBottom: 10 }, shareButton: { minHeight: 44, borderRadius: 8, borderWidth: 1, borderColor: C.line, alignItems: 'center', justifyContent: 'center', backgroundColor: C.card }, shareButtonText: { color: C.green2, fontSize: 20, fontWeight: '400' },
});

const installS = StyleSheet.create({
  promoBanner: { backgroundColor: C.card, borderWidth: 1, borderColor: C.line, borderRadius: 8, padding: 16, marginBottom: 16, flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 12 },
  promoIcon: { width: 50, height: 50, borderRadius: 8, backgroundColor: C.cardRaised, alignItems: 'center', justifyContent: 'center' },
  promoTitle: { color: C.ink, fontSize: 22, fontWeight: '500' },
  promoText: { color: C.muted, fontSize: 20, lineHeight: 25, fontWeight: '400', marginTop: 4 },
  promoActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 },
  promoButton: { minHeight: 48, borderRadius: 8, backgroundColor: C.page, paddingHorizontal: 18, alignItems: 'center', justifyContent: 'center' },
  promoButtonText: { color: C.pageInk, fontSize: 20, fontWeight: '500', textAlign: 'center' },
  promoOutlineButton: { minHeight: 48, borderRadius: 8, backgroundColor: C.cardRaised, borderWidth: 1, borderColor: C.page, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center' },
  promoOutlineText: { color: C.white, fontSize: 20, fontWeight: '500', textAlign: 'center' },
  installCard: { minHeight: 74, padding: 14, backgroundColor: C.card, borderRadius: 8, borderWidth: 1, borderColor: C.line, flexDirection: 'row', alignItems: 'center', marginBottom: 10 },
  installIcon: { width: 42, height: 42, borderRadius: 8, backgroundColor: C.cardRaised, alignItems: 'center', justifyContent: 'center', marginRight: 11 },
  installArrow: { color: C.green2, fontSize: 32.5, fontWeight: '400', marginLeft: 8 },
  installOverlay: { flex: 1, backgroundColor: 'rgba(17,24,39,.35)', alignItems: 'center', justifyContent: 'center', padding: 22 },
  installModal: { width: '100%', maxWidth: 420, backgroundColor: C.card, borderRadius: 8, borderWidth: 1, borderColor: C.line, padding: 20 },
  installModalIcon: { width: 54, height: 54, borderRadius: 8, backgroundColor: C.cardRaised, alignItems: 'center', justifyContent: 'center', marginBottom: 14 },
  installModalTitle: { color: C.ink, fontSize: 24.6, fontWeight: '500', marginBottom: 10 },
  installModalText: { color: C.muted, fontSize: 20, fontWeight: '400', lineHeight: 24, marginBottom: 8 },
  installCloseButton: { minHeight: 44, borderRadius: 8, backgroundColor: C.green, alignItems: 'center', justifyContent: 'center', marginTop: 10 },
  installCloseText: { color: C.white, fontSize: 20, fontWeight: '500' },
  apkInput: { minHeight: 56, backgroundColor: C.cardRaised, borderWidth: 1, borderColor: C.line, borderRadius: 8, paddingHorizontal: 16, fontSize: 20, color: C.ink },
  apkStatus: { fontSize: 20, lineHeight: 24, marginTop: 9 },
  apkStatusSuccess: { color: C.successDark },
  apkStatusError: { color: C.redDark },
  apkSaveButton: { minHeight: 52, borderRadius: 8, backgroundColor: C.green, alignItems: 'center', justifyContent: 'center', marginTop: 12, paddingHorizontal: 16 },
  apkSaveText: { color: C.white, fontSize: 20, fontWeight: '500' },
});

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
  deleteEquipmentType,
  fetchEquipmentTypes,
  fetchSmsQueue,
  fetchRentals,
  getSetting,
  logSentMessage,
  markRentalItemPaid,
  migrateDatabase,
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
  paidTotal,
  receiptBreakdown,
  receiptSmsText,
  receiptText,
  rentalTotal,
} from './src/utils';
import { downloadReceiptPdf, printReceipt, sendReceiptSms, sendSmsMessage } from './src/receiptActions';

const C = {
  green: '#2563EB',
  green2: '#1D4ED8',
  lime: '#EFF6FF',
  cream: '#FFFFFF',
  white: '#FFFFFF',
  ink: '#111827',
  muted: '#6B7280',
  line: '#E5E7EB',
  orange: '#2563EB',
  orangeSoft: '#EFF6FF',
  greenSoft: '#ECFDF3',
  blueSoft: '#EFF6FF',
  blue: '#2563EB',
  red: '#DC2626',
  redDark: '#B91C1C',
  redSoft: '#FEF2F2',
  redLine: '#FECACA',
  blueLine: '#BFDBFE',
  success: '#16A34A',
  successDark: '#15803D',
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
  const [splashReady, setSplashReady] = useState(false);
  const [smsSending, setSmsSending] = useState(null);

  const load = useCallback(async (silent = false) => {
    if (!silent) setRefreshing(true);
    try {
      const [rentalRows, equipmentRows, savedChannel, smsRows] = await Promise.all([
        fetchRentals(db),
        fetchEquipmentTypes(db),
        getSetting(db, 'message_channel'),
        fetchSmsQueue(db),
      ]);
      setRentals(rentalRows);
      setEquipment(equipmentRows);
      setSmsQueue(smsRows);
      if (savedChannel) setChannel(savedChannel);
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
    const standalone = window.matchMedia?.('(display-mode: standalone)')?.matches || window.navigator?.standalone;
    if (standalone) setAppInstalled(true);

    const handleBeforeInstallPrompt = (event) => {
      event.preventDefault();
      setInstallPrompt(event);
    };
    const handleAppInstalled = () => {
      setAppInstalled(true);
      setInstallPrompt(null);
    };
    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    window.addEventListener('appinstalled', handleAppInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
      window.removeEventListener('appinstalled', handleAppInstalled);
    };
  }, []);

  const active = useMemo(() => rentals.filter((rental) => !isClosed(rental)), [rentals]);
  const history = useMemo(() => rentals.filter(isClosed), [rentals]);

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
    try {
      const outcome = await editRental(db, editTarget.id, changes);
      const rows = await load(true);
      const updated = rows.find((row) => row.id === editTarget.id);
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
    } catch (error) {
      Alert.alert('O‘zgarishlar saqlanmadi', error.message || 'O‘zgarishlarni saqlashda xatolik yuz berdi.');
    }
  };

  const confirmPaid = async (itemId) => {
    try {
      await markRentalItemPaid(db, itemId);
      const rows = await load(true);
      if (selected) setSelected(rows.find((row) => row.id === selected.id) || selected);
    } catch (error) {
      Alert.alert('To‘lov saqlanmadi', error.message || 'To‘lov holatini o‘zgartirib bo‘lmadi.');
    }
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
    if (!installPrompt) {
      setInstallHelpOpen(true);
      return;
    }
    await installPrompt.prompt();
    const choice = await installPrompt.userChoice;
    if (choice?.outcome === 'accepted') setAppInstalled(true);
    setInstallPrompt(null);
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
            pendingRentals={rentals.filter((rental) => pendingPaymentItems(rental).length > 0)}
            refreshing={refreshing}
            onRefresh={() => load()}
            onNew={() => setNewOpen(true)}
            onRental={setSelected}
          />
        )}
        {screen === 'customers' && <Customers rentals={rentals} onRental={setSelected} />}
        {screen === 'history' && (
          <History rentals={history} refreshing={refreshing} onRefresh={() => load()} onReceipt={(rental) => setReceipt({ rental, context: { type: 'final' } })} />
        )}
        {screen === 'settings' && <Settings channel={channel} onChange={changeChannel} onInventory={() => setScreen('inventory')} onSmsQueue={() => setScreen('sms')} smsPendingCount={smsQueue.filter((item) => item.status === 'pending').length} onInstallApp={installApp} installAvailable={Boolean(installPrompt)} installed={appInstalled} remoteMode={usesRemoteDatabase} />}
        {screen === 'sms' && <SmsQueue items={smsQueue} sending={smsSending} onSend={sendQueuedSms} onSendAll={sendAllQueuedSms} onBack={() => setScreen('settings')} />}
        {screen === 'inventory' && <Inventory equipment={equipment} refreshing={refreshing} onRefresh={() => load()} onBack={() => setScreen('settings')} onAdd={() => setEquipmentEditor({ mode: 'create', item: null })} onEdit={(item) => setEquipmentEditor({ mode: 'edit', item })} onDelete={handleDeleteEquipment} />}

        <BottomNav screen={screen} onChange={setScreen} />
      </View>

      <NewRentalModal open={newOpen} equipment={equipment} onClose={() => setNewOpen(false)} onSubmit={submitRental} />
      <RentalDetail
        rental={selected}
        onClose={() => setSelected(null)}
        onEdit={() => setEditTarget(selected)}
        onPay={confirmPaid}
        onReceipt={(rental) => { setSelected(null); setReceipt({ rental, context: { type: isClosed(rental) ? 'final' : 'current' } }); }}
      />
      <RentalEditModal target={editTarget} equipment={equipment} onClose={() => setEditTarget(null)} onSubmit={submitEdit} />
      <EquipmentModal editor={equipmentEditor} onClose={() => setEquipmentEditor(null)} onSubmit={saveEquipment} />
      <EquipmentDeleteModal item={equipmentDeleteTarget} error={equipmentDeleteError} onClose={() => { setEquipmentDeleteTarget(null); setEquipmentDeleteError(''); }} onConfirm={confirmDeleteEquipment} />
      <InstallAppModal open={installHelpOpen} installed={appInstalled} onClose={() => setInstallHelpOpen(false)} />
      <ReceiptModal
        receipt={receipt}
        channel={channel}
        onClose={() => setReceipt(null)}
        onDownload={saveReceiptPdf}
        onPrint={printRentalReceipt}
        onSms={smsReceipt}
        onShare={shareReceipt}
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
  return returnedItems(rental).filter((item) => !item.paid);
}

function paidReturnedItems(rental) {
  return returnedItems(rental).filter((item) => item.paid);
}

function pendingPaymentTotal(rental) {
  return pendingPaymentItems(rental).reduce((total, item) => total + lineAmount(rental, item), 0);
}

function quantityOf(items) {
  return items.reduce((total, item) => total + Number(item.quantity || 0), 0);
}

function lineAmount(rental, item) {
  return Number(item.amount ?? item.frozenAmount ?? itemTotal(rental, item));
}

function statusTone(days) {
  if (days >= 14) return { color: C.red, background: '#FDECEC', label: 'Uzoq muddat' };
  if (days >= 7) return { color: C.blue, background: C.blueSoft, label: 'O‘rtacha muddat' };
  return { color: C.neutral, background: '#F9FAFB', label: 'Yangi' };
}

function Dashboard({ rentals, pendingRentals, refreshing, onRefresh, onNew, onRental }) {
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
        <View style={s.metricGrid}>
          <View style={s.metricCard}><Text style={s.metricLabel}>FAOL IJARALAR</Text><Text style={s.metricValue}>{rentals.length}</Text><Text style={s.metricHint}>{customerCount} faol mijoz</Text></View>
          <View style={[s.metricCard, s.metricCardAmber, { backgroundColor: C.redSoft, borderColor: C.redLine }]}><Text style={[s.metricLabelAmber, { color: C.redDark }]}>JAMI QARZ</Text><Text style={[s.metricValueAmber, { color: C.redDark }]}>{formatMoney(debt)}</Text><Text style={[s.metricHintAmber, { color: C.redDark }]}>real-time hisob</Text></View>
        </View>
        <Pressable style={s.dashboardAddButton} onPress={onNew}><Text style={s.dashboardAddText}>＋  Yangi ijara qo‘shish</Text></Pressable>
        {pendingRentals.length > 0 && <View style={s.pendingPanel}>
          <View style={s.pendingPanelHead}><View><Text style={s.pendingPanelTitle}>To‘lov kutilmoqda</Text><Text style={s.pendingPanelSub}>Buyum qaytdi, to‘lov hali tasdiqlanmagan</Text></View><Text style={s.pendingPanelTotal}>{formatMoney(pendingTotal)}</Text></View>
          {pendingRentals.map((rental) => <Pressable key={rental.id} style={s.pendingPanelRow} onPress={() => onRental(rental)}><View style={s.flex}><Text style={s.customerName}>{rental.customerName}</Text><Text style={s.phone}>{quantityOf(pendingPaymentItems(rental))} dona qaytgan anjom</Text></View><Text style={s.pendingPanelAmount}>{formatMoney(pendingPaymentTotal(rental))}</Text></Pressable>)}
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

function Settings({ channel, onChange, onInventory, onSmsQueue, smsPendingCount, onInstallApp, installAvailable, installed, remoteMode }) {
  const storageLabel = remoteMode ? 'Umumiy Supabase bazasi' : 'Qurilma SQLite bazasi';
  const storageNote = remoteMode
    ? 'Production rejimida barcha ma’lumotlar umumiy onlayn bazada saqlanadi va boshqa foydalanuvchilarga ko‘rinadi.'
    : 'Lokal rejimda ma’lumotlar shu qurilmaning o‘zida saqlanadi.';
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.screenContent}>
      <View style={s.topBrand}><Brand /></View>
      <Header title="Sozlamalar" subtitle="Ilova va xabar yuborish" />
      <View style={s.settingsCard}><Text style={s.settingsTitle}>Chek yuborish kanali</Text><Text style={s.settingsText}>Mijozga chek ulashilganda birlamchi kanal sifatida ishlatiladi.</Text><View style={s.channelGrid}>{['SMS', 'Telegram', 'WhatsApp'].map((item) => <Pressable key={item} onPress={() => onChange(item)} style={[s.channel, channel === item && s.channelActive]}><Text style={[s.channelText, channel === item && s.channelTextActive]}>{item}</Text></Pressable>)}</View></View>
      <Pressable style={installS.installCard} onPress={onInstallApp}>
        <View style={installS.installIcon}><MaterialCommunityIcons name="cellphone-arrow-down" size={25} color={C.green2} /></View>
        <View style={s.flex}><Text style={s.settingsTitle}>Ilova versiyasi</Text><Text style={s.settingsText}>{installed ? 'Ilova bosh ekranga o‘rnatilgan.' : installAvailable ? 'O‘rnatish oynasini ochish uchun bosing.' : 'Saytni telefon bosh ekraniga o‘rnating.'}</Text></View>
        <Text style={installS.installArrow}>›</Text>
      </Pressable>
      <View style={s.settingsCard}><Text style={s.settingsTitle}>Ma’lumotlar</Text><InfoRow label="Saqlash" value={storageLabel} /><InfoRow label="Hisoblash" value="Real-time, cron ishlatilmaydi" /><InfoRow label="Versiya" value="1.0.0 MVP" /></View>
      <Pressable style={s.inventoryLink} onPress={onInventory}><View><Text style={s.settingsTitle}>Ombor jadvali</Text><Text style={s.settingsText}>Anjomlar va faol ijaradagi sonlarni ko‘rish</Text></View><Text style={s.inventoryArrow}>›</Text></Pressable>
      <Pressable style={s.inventoryLink} onPress={onSmsQueue}><View><Text style={s.settingsTitle}>SMS navbati</Text><Text style={s.settingsText}>{smsPendingCount ? `${smsPendingCount} ta xabar yuborishni kutmoqda` : 'Yuborilgan va kutilayotgan xabarlar'}</Text></View><Text style={s.inventoryArrow}>›</Text></Pressable>
      <View style={s.note}><Text style={s.noteTitle}>Eslatma</Text><Text style={s.noteText}>{storageNote} SMS/Telegram/WhatsApp yuborish uchun tegishli API ulanishi kerak.</Text></View>
    </ScrollView>
  );
}

function InfoRow({ label, value }) {
  return <View style={s.infoRow}><Text style={s.infoLabel}>{label}</Text><Text style={s.infoValue}>{value}</Text></View>;
}

function InstallAppModal({ open, installed, onClose }) {
  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={onClose}>
      <View style={installS.installOverlay}>
        <View style={installS.installModal}>
          <View style={installS.installModalIcon}><MaterialCommunityIcons name="cellphone-arrow-down" size={30} color={C.green2} /></View>
          <Text style={installS.installModalTitle}>{installed ? 'Ilova o‘rnatilgan' : 'Ilovani o‘rnatish'}</Text>
          <Text style={installS.installModalText}>Android Chrome’da brauzer menyusidan “Install app” yoki “Add to Home screen”ni tanlang.</Text>
          <Text style={installS.installModalText}>iPhone’da Safari → Share → “Add to Home Screen”ni bosing.</Text>
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
  const blank = () => ({ key: `${Date.now()}_${Math.random()}`, name: '', quantity: '1', dailyPrice: '' });
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
        <Pressable style={[s.addItem, { borderColor: C.blueLine }]} onPress={() => setItems((rows) => [...rows, blank()])}><Text style={s.addItemText}>＋ Yana anjom qo‘shish</Text></Pressable>
        <View style={[s.dailyTotal, { borderColor: C.blueLine }]}><Text style={s.dailyLabel}>Bir kunlik umumiy ijara</Text><Text style={s.dailyValue}>{formatMoney(daily)}</Text></View>
        <Pressable disabled={saving} style={[s.mainButton, saving && { opacity: .6 }]} onPress={submit}>{saving ? <ActivityIndicator color={C.white} /> : <Text style={s.mainButtonText}>Ijarani rasmiylashtirish</Text>}</Pressable>
      </ScrollView></KeyboardAvoidingView></SafeAreaView>
    </Modal>
  );
}

function RentalDetail({ rental, onClose, onEdit, onPay, onReceipt }) {
  const activeItems = rental ? openItems(rental) : [];
  const pendingItems = rental ? pendingPaymentItems(rental) : [];
  const paidItems = rental ? paidReturnedItems(rental) : [];
  const activeQuantity = quantityOf(activeItems);

  return <Modal visible={Boolean(rental)} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>{rental && <SafeAreaView style={s.modalPage}><ScrollView contentContainerStyle={s.modalContent}>
    <ModalHeader title={rental.customerName} subtitle={rental.phone} onClose={onClose} />
    <View style={[s.detailSummary, { backgroundColor: C.redSoft, borderColor: C.redLine }]}>
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
        <View style={s.detailItemTop}><View style={s.flex}><Text style={s.detailItemName}>↩ {item.name} × {item.quantity}</Text><Text style={s.detailItemSub}>{formatDate(item.returnedAt, true)} · {dayCount(item.startedAt || rental.startedAt, item.returnedAt)} kun · to‘lov kutilmoqda</Text></View><Text style={[s.returnHistoryAmount, { color: C.orange }]}>{formatMoney(lineAmount(rental, item))}</Text></View>
        <View style={s.pendingPaymentFooter}><Text style={[s.paidBadgeText, { color: C.orange }]}>BUYUM QAYTDI</Text><Pressable style={s.paidConfirmButton} onPress={() => onPay(item.id)}><Text style={s.paidConfirmText}>To‘landi</Text></Pressable></View>
      </View>)}
    </>}

    {paidItems.length > 0 && <>
      <View style={s.detailSectionHeader}><Text style={s.itemsTitle}>Qaytarish tarixi</Text><Text style={[s.paidSectionTotal, { color: C.successDark }]}>{formatMoney(paidTotal(rental))} to‘langan</Text></View>
      {paidItems.map((item) => <View key={item.id} style={s.returnHistoryItem}>
        <View style={s.detailItemTop}><View style={s.flex}><Text style={s.detailItemName}>✓ {item.name} × {item.quantity}</Text><Text style={s.detailItemSub}>{formatDate(item.returnedAt, true)} · {dayCount(item.startedAt || rental.startedAt, item.returnedAt)} kun</Text></View><Text style={[s.returnHistoryAmount, { color: C.successDark }]}>{formatMoney(lineAmount(rental, item))}</Text></View>
        <View style={s.paidBadge}><Text style={[s.paidBadgeText, { color: C.successDark }]}>TO‘LANDI</Text></View>
      </View>)}
    </>}

    <Pressable style={s.returnButton} onPress={onEdit}><Text style={s.returnButtonText}>Tahrirlash</Text></Pressable>
    <Pressable style={s.receiptButton} onPress={() => onReceipt(rental)}><Text style={s.receiptButtonText}>▧  {isClosed(rental) ? 'Yakuniy chekni ko‘rish' : 'Elektron chekni ko‘rish'}</Text></Pressable>
  </ScrollView></SafeAreaView>}</Modal>;
}

function RentalEditModal({ target, equipment, onClose, onSubmit }) {
  const activeItems = target ? openItems(target) : [];
  const [returnQuantities, setReturnQuantities] = useState({});
  const [addQuantities, setAddQuantities] = useState({});
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (target) {
      setReturnQuantities(Object.fromEntries(openItems(target).map((item) => [item.id, '0'])));
      setAddQuantities(Object.fromEntries((equipment || []).map((item) => [item.id, '0'])));
      setSaving(false);
    }
  }, [target?.id, equipment]);

  const updateReturnQuantity = (itemId, value) => setReturnQuantities((values) => ({ ...values, [itemId]: value.replace(/[^0-9]/g, '') }));
  const updateAddQuantity = (itemId, value) => setAddQuantities((values) => ({ ...values, [itemId]: value.replace(/[^0-9]/g, '') }));
  const submit = async () => {
    const invalidReturn = activeItems.find((item) => Number(returnQuantities[item.id] || 0) > Number(item.quantity));
    if (invalidReturn) return Alert.alert('Son noto‘g‘ri', `${invalidReturn.name} uchun 0 dan ${invalidReturn.quantity} tagacha son kiriting.`);
    const invalidAdd = (equipment || []).find((item) => Number(addQuantities[item.id] || 0) > Number(item.availableQuantity || 0));
    if (invalidAdd) return Alert.alert('Omborda yetarli emas', `${invalidAdd.name} uchun omborda faqat ${invalidAdd.availableQuantity} dona mavjud.`);
    const returns = activeItems.map((item) => ({ itemId: item.id, quantity: Number(returnQuantities[item.id] || 0) })).filter((entry) => entry.quantity > 0);
    const additions = (equipment || []).map((item) => ({
      equipmentTypeId: item.id,
      name: item.name,
      dailyPrice: item.dailyPrice,
      quantity: Number(addQuantities[item.id] || 0),
    })).filter((entry) => entry.quantity > 0);
    if (!returns.length && !additions.length) return Alert.alert('O‘zgarish kiritilmadi', 'Hech qanday o‘zgarish kiritilmadi.');
    setSaving(true);
    try { await onSubmit({ returns, additions }); } finally { setSaving(false); }
  };

  return <Modal visible={Boolean(target)} transparent animationType="fade" onRequestClose={onClose}><View style={s.overlay}><KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={s.returnSheet}>{target && <>
    <ModalHeader title="Tahrirlash" subtitle={target.customerName} onClose={onClose} />
    <ScrollView style={s.returnItemsScroll} contentContainerStyle={s.returnItemsList} keyboardShouldPersistTaps="handled">
      {activeItems.length > 0 && <>
        <Text style={s.itemsTitle}>Qaytarilgan anjomlar</Text>
        <Text style={s.returnHint}>Qaytgan miqdorni kiriting. Qolgan anjomlar mijozda qoladi va hisob davom etadi.</Text>
        {activeItems.map((item) => <View key={item.id} style={s.returnItemCard}>
          <View style={s.returnItemHeading}><View style={s.flex}><Text style={s.detailItemName}>{item.name}</Text><Text style={s.returnItemMeta}>Mijozda hozir: {item.quantity} ta · {formatMoney(item.dailyPrice)}/kun</Text></View><Text style={s.returnMax}>maks. {item.quantity}</Text></View>
          <Field label="NECHTA QAYTARDI?"><TextInput style={s.input} value={returnQuantities[item.id] ?? '0'} onChangeText={(value) => updateReturnQuantity(item.id, value)} keyboardType="number-pad" placeholder="0" placeholderTextColor="#9AA49F" /></Field>
        </View>)}
      </>}
      <Text style={[s.itemsTitle, { marginTop: 14 }]}>Yana anjom olib ketdimi?</Text>
      <Text style={s.returnHint}>Omborda mavjud anjomdan qo‘shimcha berilgan miqdorni kiriting. Bu anjom uchun hisob bugundan boshlanadi.</Text>
      {(equipment || []).map((item) => <View key={item.id} style={s.returnItemCard}>
        <View style={s.returnItemHeading}><View style={s.flex}><Text style={s.detailItemName}>{item.name}</Text><Text style={s.returnItemMeta}>Omborda mavjud: {item.availableQuantity} ta · {formatMoney(item.dailyPrice)}/kun</Text></View><Text style={s.returnMax}>maks. {item.availableQuantity}</Text></View>
        <Field label="QO‘SHILADIGAN SON"><TextInput style={s.input} value={addQuantities[item.id] ?? '0'} onChangeText={(value) => updateAddQuantity(item.id, value)} keyboardType="number-pad" placeholder="0" placeholderTextColor="#9AA49F" /></Field>
      </View>)}
    </ScrollView>
    <Pressable disabled={saving} style={[s.mainButton, saving && { opacity: .65 }]} onPress={submit}>{saving ? <ActivityIndicator color={C.white} /> : <Text style={s.mainButtonText}>Saqlash</Text>}</Pressable>
  </>}</KeyboardAvoidingView></View></Modal>;
}

function ReceiptModal({ receipt, channel, onClose, onDownload, onPrint, onSms, onShare }) {
  const [busy, setBusy] = useState(null);
  const rental = receipt?.rental;
  const context = receipt?.context || { type: 'current' };
  const breakdown = rental ? receiptBreakdown(rental, context) : null;
  const type = context.type || 'current';
  const isPartial = type === 'partial';
  const isEdit = type === 'edit';
  const isFinal = type === 'final' || breakdown?.isFinal;
  const returned = breakdown?.returnedItems || [];
  const added = breakdown?.addedItems || [];
  const remaining = breakdown?.openItems || [];
  const returnedTotal = breakdown?.returnedTotal ?? 0;
  const current = breakdown?.currentDebt ?? 0;
  const final = breakdown?.finalTotal ?? rentalTotal(rental || { items: [] });
  const pendingReturned = returned.filter((item) => !item.paid);
  const title = isEdit ? 'Ijara o‘zgarishi cheki' : isPartial ? 'Qisman qaytarish cheki' : isFinal ? 'Yakuniy chek' : type === 'new' ? 'Yangi ijara cheki' : 'Joriy elektron chek';
  useEffect(() => setBusy(null), [rental?.id, type, context.returnedItemIds?.join(','), context.addedItemIds?.join(',')]);
  const run = async (name, action) => {
    setBusy(name);
    try { await action(receipt); } finally { setBusy(null); }
  };
  return <Modal visible={Boolean(rental)} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>{rental && <SafeAreaView style={s.modalPage}><ScrollView contentContainerStyle={s.modalContent}>
    <ModalHeader title={title} subtitle={isEdit ? 'Qaytarish va qo‘shimcha anjomlar' : isPartial ? 'Qaytarilgan qism bo‘yicha to‘lov' : isFinal ? 'Barcha anjomlar qaytarilgan' : 'Hisob real vaqtda yangilanadi'} onClose={onClose} />
    <View style={s.receiptPaper}>
      <View style={s.receiptHead}><Brand /><Text style={s.receiptNumber}>#{rental.id.slice(-8).toUpperCase()}</Text></View>
      <View style={s.receiptCustomer}><Text style={s.receiptName}>{rental.customerName}</Text><Text style={s.phone}>{rental.phone}</Text><Text style={s.receiptDate}>{formatDate(new Date(), true)}</Text></View>

      {returned.length > 0 && <>
        <Text style={s.receiptSectionTitle}>{isPartial ? 'QAYTARILGAN QISM' : 'QAYTARILGAN ANJOMLAR'}</Text>
        {returned.map((item) => <View key={item.id} style={s.receiptRow}><View style={s.flex}><Text style={s.receiptItemName}>{item.paid ? '✓' : '◷'} {item.name} × {item.quantity}</Text><Text style={s.receiptItemSub}>{dayCount(item.startedAt || rental.startedAt, item.returnedAt)} kun · {formatMoney(item.dailyPrice)}/kun · {item.paid ? 'TO‘LANDI' : 'TO‘LOV KUTILMOQDA'}</Text></View><Text style={[s.receiptPaidAmount, { color: item.paid ? C.successDark : C.orange }]}>{formatMoney(lineAmount(rental, item))}</Text></View>)}
      </>}

      {isEdit && added.length > 0 && <>
        <Text style={s.receiptSectionTitle}>QO‘SHIMCHA OLINGAN ANJOMLAR</Text>
        {added.map((item) => <View key={item.id} style={s.receiptRow}><View style={s.flex}><Text style={s.receiptItemName}>＋ {item.name} × {item.quantity}</Text><Text style={s.receiptItemSub}>Bugun olindi · {formatMoney(item.dailyPrice)}/kun · JORIY QARZ</Text></View><Text style={[s.receiptOpenAmount, { color: C.redDark }]}>{formatMoney(lineAmount(rental, item))}</Text></View>)}
      </>}

      {!isFinal && remaining.length > 0 && <View style={[s.receiptCurrentBlock, { backgroundColor: C.redSoft, borderColor: C.redLine }]}>
        <Text style={[s.receiptCurrentTitle, { color: C.redDark }]}>JORIY QARZ — O‘SISHDA DAVOM ETMOQDA</Text>
        {remaining.map((item) => <View key={item.id} style={s.receiptOpenRow}><Text style={s.receiptItemName}>{item.name} × {item.quantity}</Text><Text style={[s.receiptOpenAmount, { color: C.redDark }]}>{formatMoney(lineAmount(rental, item))}</Text></View>)}
        <Text style={[s.receiptCurrentTotal, { color: C.redDark, borderTopColor: C.redLine }]}>{formatMoney(current)}</Text>
        {isPartial && <Text style={s.receiptReminder}>Qolgan {quantityOf(remaining)} dona anjom qaytarilmaguncha, kunlik hisob davom etadi.</Text>}
      </View>}

      {(isPartial || isEdit) && returned.length > 0 && <View style={s.receiptGrand}><Text style={s.receiptGrandLabel}>{pendingReturned.length ? 'TO‘LOV KUTILMOQDA' : 'QAYTARILGAN QISM TO‘LANDI'}</Text><Text style={[s.receiptGrandValue, { color: pendingReturned.length ? C.orange : C.successDark }]}>{formatMoney(returnedTotal)}</Text></View>}
      {isFinal && (pendingReturned.length ? <View style={s.receiptGrand}><Text style={s.receiptGrandLabel}>TO‘LOV KUTILMOQDA</Text><Text style={[s.receiptGrandValue, { color: C.orange }]}>{formatMoney(pendingReturned.reduce((sum, item) => sum + lineAmount(rental, item), 0))}</Text></View> : <View style={s.receiptGrand}><Text style={s.receiptGrandLabel}>YAKUNIY JAMI</Text><Text style={[s.receiptGrandValue, { color: C.successDark }]}>{formatMoney(final)}</Text></View>)}
      {!isPartial && !isFinal && <View style={s.receiptGrand}><Text style={s.receiptGrandLabel}>JORIY QARZ</Text><Text style={[s.receiptGrandValue, { color: C.redDark }]}>{formatMoney(current)}</Text></View>}
    </View>
    <View style={s.receiptActionGrid}><ReceiptAction icon="↓" label="PDF yuklab olish" primary busy={busy === 'pdf'} disabled={Boolean(busy)} onPress={() => run('pdf', onDownload)} /><ReceiptAction icon="▣" label="Chop etish" busy={busy === 'print'} disabled={Boolean(busy)} onPress={() => run('print', onPrint)} /><ReceiptAction icon="✉" label="SMS yuborish" orange busy={busy === 'sms'} disabled={Boolean(busy)} onPress={() => run('sms', onSms)} /></View>
    <Text style={s.shareHint}>Birlamchi kanal: <Text style={{ fontWeight: '500', color: C.ink }}>{channel}</Text></Text><Pressable disabled={Boolean(busy)} style={s.shareButton} onPress={() => run('share', onShare)}><Text style={s.shareButtonText}>{busy === 'share' ? 'Tayyorlanmoqda...' : 'Boshqa ilovaga ulashish'}</Text></Pressable>
  </ScrollView></SafeAreaView>}</Modal>;
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
  safe: { flex: 1, backgroundColor: C.white }, app: { flex: 1 }, flex: { flex: 1 },
  loader: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 18, backgroundColor: C.white },
  splash: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: C.white }, splashTitle: { color: C.ink, fontSize: 26, fontWeight: '500', marginTop: 16 }, splashSub: { color: C.muted, fontSize: 20, fontWeight: '400', marginTop: 6 },
  logoFrame: { alignItems: 'center', justifyContent: 'center', backgroundColor: C.white, borderWidth: 1.5, borderColor: C.green, overflow: 'hidden' },
  screen: { flex: 1, backgroundColor: C.white }, screenContent: { paddingHorizontal: 16, paddingTop: Platform.OS === 'android' ? 16 : 8, paddingBottom: 200 },
  topBrand: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }, brand: { flexDirection: 'row', alignItems: 'center', gap: 10 }, brandName: { fontSize: 23.3, lineHeight: 26.6, fontWeight: '500', color: C.ink }, brandSub: { fontSize: 20, fontWeight: '400', color: C.muted, letterSpacing: 1.1, marginTop: 2 },
  smallAdd: { width: 48, height: 48, borderRadius: 10, backgroundColor: C.green, alignItems: 'center', justifyContent: 'center' }, smallAddText: { color: C.white, fontSize: 33.8, fontWeight: '400', marginTop: -2 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }, headerTitle: { color: C.ink, fontSize: 32.5, fontWeight: '500', letterSpacing: -.3 }, headerSub: { color: C.muted, fontSize: 20, fontWeight: '400', marginTop: 4, textTransform: 'capitalize' },
  metricGrid: { flexDirection: 'row', gap: 10, marginBottom: 12 }, metricCard: { flex: 1, minHeight: 120, padding: 16, borderRadius: 12, borderWidth: 1, borderColor: C.line, backgroundColor: C.white }, metricCardAmber: { backgroundColor: C.orangeSoft, borderColor: C.blueLine }, metricLabel: { color: C.muted, fontSize: 20, fontWeight: '400', letterSpacing: .5 }, metricValue: { color: C.ink, fontSize: 32.5, fontWeight: '500', marginTop: 10 }, metricHint: { color: C.muted, fontSize: 20, fontWeight: '400', marginTop: 4 }, metricLabelAmber: { color: C.green2, fontSize: 20, fontWeight: '400', letterSpacing: .5 }, metricValueAmber: { color: C.green2, fontSize: 22.1, fontWeight: '500', marginTop: 13 }, metricHintAmber: { color: C.green2, fontSize: 20, fontWeight: '400', marginTop: 6 }, dashboardAddButton: { minHeight: 56, borderRadius: 12, backgroundColor: C.green, alignItems: 'center', justifyContent: 'center', marginBottom: 22 }, dashboardAddText: { color: C.white, fontSize: 20, fontWeight: '500' },
  sectionTitleRow: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 10 }, sectionTitle: { color: C.ink, fontSize: 22.1, fontWeight: '500' }, sectionSub: { color: C.muted, fontSize: 20, fontWeight: '400', marginTop: 3 }, resultCount: { color: C.green2, fontSize: 20, fontWeight: '400' }, searchBox: { height: 52, borderRadius: 12, borderWidth: 1, borderColor: C.line, backgroundColor: C.white, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, marginBottom: 12 }, searchIcon: { fontSize: 24.6, color: C.muted, marginRight: 7 }, searchInput: { flex: 1, height: '100%', fontSize: 20, fontWeight: '400', color: C.ink },
  rentalCard: { backgroundColor: C.white, borderRadius: 14, borderWidth: 1, borderLeftWidth: 4, borderColor: C.line, padding: 16 }, pressed: { opacity: .72 }, customerRow: { flexDirection: 'row', alignItems: 'center' }, avatar: { width: 42, height: 42, borderRadius: 21, backgroundColor: C.greenSoft, alignItems: 'center', justifyContent: 'center', marginRight: 10 }, avatarText: { color: C.green, fontWeight: '500', fontSize: 20 }, customerName: { color: C.ink, fontSize: 20, fontWeight: '500' }, phone: { color: C.muted, fontSize: 20, fontWeight: '400', marginTop: 3 }, arrow: { color: C.muted, fontSize: 28.6 }, cardAmount: { alignItems: 'flex-end', marginLeft: 8 }, cardAmountLabel: { color: C.muted, fontSize: 20, fontWeight: '400', letterSpacing: .4 }, cardAmountValue: { fontSize: 20, fontWeight: '500', marginTop: 4 }, cardDivider: { height: 1, backgroundColor: C.line, marginVertical: 12 }, rentalMeta: { flexDirection: 'row' }, meta: { flex: 1 }, metaLabel: { color: C.muted, fontSize: 20, fontWeight: '400', letterSpacing: .4, marginBottom: 4 }, metaValue: { color: C.ink, fontSize: 20, fontWeight: '400' }, cardPaidNote: { marginTop: 10, paddingTop: 9, borderTopWidth: 1, borderTopColor: C.line }, cardPaidNoteText: { color: C.green2, fontSize: 20, fontWeight: '400' },
  customerListCard: { minHeight: 78, padding: 15, backgroundColor: C.white, borderRadius: 12, borderWidth: 1, borderColor: C.line, flexDirection: 'row', alignItems: 'center' }, customerDebt: { color: C.green2, fontSize: 20, fontWeight: '500', marginLeft: 8 },
  backLink: { alignSelf: 'flex-start', marginBottom: 12 }, backLinkText: { color: C.green2, fontSize: 20, fontWeight: '400' }, inventoryTable: { backgroundColor: C.white, borderRadius: 12, borderWidth: 1, borderColor: C.line, overflow: 'hidden' }, inventoryHeader: { minHeight: 46, backgroundColor: C.orangeSoft, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12 }, inventoryHeaderText: { color: C.green2, fontSize: 20, fontWeight: '400', letterSpacing: .4 }, inventoryRow: { minHeight: 52, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, borderTopWidth: 1, borderTopColor: C.line }, inventoryCellName: { flex: 1.5, color: C.ink, fontSize: 20, fontWeight: '400' }, inventoryCell: { flex: 1, color: C.muted, fontSize: 20, fontWeight: '400', textAlign: 'right' }, inventoryLink: { minHeight: 78, padding: 16, backgroundColor: C.white, borderRadius: 12, borderWidth: 1, borderColor: C.line, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }, inventoryArrow: { color: C.green2, fontSize: 31.1, fontWeight: '400' },
  inventoryTopRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 2 }, inventoryBackButton: { width: 40, height: 40, borderRadius: 9, alignItems: 'center', justifyContent: 'center', backgroundColor: '#F9FAFB', borderWidth: 1, borderColor: C.line }, inventoryBackText: { color: C.green2, fontSize: 29.8, lineHeight: 31.6, fontWeight: '400', marginTop: -2 }, inventoryTitle: { color: C.ink, fontSize: 27.3, fontWeight: '500' }, inventorySubtitle: { color: C.muted, fontSize: 20, fontWeight: '400', marginBottom: 12 }, inventoryMetricGrid: { flexDirection: 'row', gap: 8, marginBottom: 9 }, inventoryMetricCard: { flex: 1, minHeight: 96, padding: 15, borderRadius: 10, borderWidth: 1, borderColor: C.line, backgroundColor: C.white }, inventoryMetricCardAmber: { backgroundColor: C.orangeSoft, borderColor: C.blueLine }, inventoryMetricLabel: { color: C.muted, fontSize: 20, fontWeight: '400', letterSpacing: .4 }, inventoryMetricValue: { color: C.ink, fontSize: 28.6, fontWeight: '500', marginTop: 7 }, inventoryMetricHint: { color: C.muted, fontSize: 20, fontWeight: '400', marginTop: 3 }, inventoryMetricLabelAmber: { color: C.green2, fontSize: 20, fontWeight: '400', letterSpacing: .4 }, inventoryMetricValueAmber: { color: C.green2, fontSize: 28.6, fontWeight: '500', marginTop: 7 }, inventoryMetricHintAmber: { color: C.green2, fontSize: 20, fontWeight: '400', marginTop: 3 }, inventoryAddButton: { minHeight: 54, borderRadius: 11, backgroundColor: C.green, alignItems: 'center', justifyContent: 'center', marginBottom: 14 }, inventoryAddText: { color: C.white, fontSize: 20, fontWeight: '500' }, inventoryCard: { backgroundColor: C.white, borderRadius: 12, borderWidth: 1, borderColor: C.line, padding: 16, marginBottom: 8 }, inventoryCardDepleted: { borderColor: C.line, borderLeftWidth: 3, borderLeftColor: C.red }, inventoryCardTop: { flexDirection: 'row', alignItems: 'flex-start' }, inventoryName: { color: C.ink, fontSize: 20, fontWeight: '500' }, inventoryDaily: { color: C.muted, fontSize: 20, fontWeight: '400', marginTop: 4 }, inventoryMenuButton: { width: 36, height: 34, alignItems: 'center', justifyContent: 'center' }, inventoryMenuText: { color: C.muted, fontSize: 20.8, letterSpacing: 1 }, inventoryStats: { flexDirection: 'row', gap: 8, paddingTop: 10, marginTop: 10, borderTopWidth: 1, borderTopColor: C.line }, inventoryStat: { flex: 1 }, inventoryStatLabel: { color: C.muted, fontSize: 20, fontWeight: '400', letterSpacing: .45, marginBottom: 3 }, inventoryStatValue: { color: C.ink, fontSize: 20.8, fontWeight: '500' }, inventoryStatValueAvailable: { color: '#2F855A', fontSize: 20.8, fontWeight: '500' }, inventoryStatValueDepleted: { color: C.redDark, fontSize: 20.8, fontWeight: '500' }, inventoryAvailableRow: { flexDirection: 'row', alignItems: 'baseline', gap: 6 }, inventoryUnavailable: { color: C.redDark, fontSize: 20, fontWeight: '400' }, inventoryStockStatus: { alignSelf: 'flex-start', borderRadius: 10, paddingVertical: 5, paddingHorizontal: 9, marginTop: 13 }, inventoryStockAvailable: { backgroundColor: '#ECFDF3' }, inventoryStockDepleted: { backgroundColor: '#FDECEC' }, inventoryStockStatusText: { color: '#2F855A', fontSize: 20, fontWeight: '500', letterSpacing: .5 }, inventoryMenuRow: { flexDirection: 'row', gap: 8, marginTop: 10, paddingTop: 8, borderTopWidth: 1, borderTopColor: C.line }, inventoryMenuAction: { flex: 1, minHeight: 44, borderRadius: 8, backgroundColor: '#F9FAFB', borderWidth: 1, borderColor: C.line, alignItems: 'center', justifyContent: 'center' }, inventoryMenuActionDanger: { flex: 1, minHeight: 44, borderRadius: 8, backgroundColor: '#FDECEC', borderWidth: 1, borderColor: '#F4B5B4', alignItems: 'center', justifyContent: 'center' }, inventoryMenuActionText: { color: C.ink, fontSize: 20, fontWeight: '400' }, inventoryMenuActionDangerText: { color: C.redDark, fontSize: 20, fontWeight: '400' }, equipmentModalHint: { color: C.muted, fontSize: 20, fontWeight: '400', lineHeight: 24, marginTop: -2, marginBottom: 18 }, deleteConfirmText: { color: C.ink, fontSize: 20, fontWeight: '400', lineHeight: 27.8, marginBottom: 10 }, deleteErrorBox: { borderWidth: 1, borderColor: '#F4B5B4', borderRadius: 10, backgroundColor: '#FDECEC', padding: 12, marginBottom: 15 }, deleteErrorText: { color: C.redDark, fontSize: 20, fontWeight: '400', lineHeight: 24 }, deleteActions: { flexDirection: 'row', gap: 8, marginTop: 8 }, deleteCancelButton: { flex: 1, minHeight: 52, borderRadius: 10, borderWidth: 1, borderColor: C.line, backgroundColor: C.white, alignItems: 'center', justifyContent: 'center' }, deleteCancelText: { color: C.ink, fontSize: 20, fontWeight: '400' }, deleteConfirmButton: { flex: 1, minHeight: 52, borderRadius: 10, backgroundColor: C.red, alignItems: 'center', justifyContent: 'center' }, deleteConfirmTextButton: { color: C.white, fontSize: 20, fontWeight: '500' }, 
  historyCard: { padding: 14, backgroundColor: C.white, borderRadius: 12, borderWidth: 1, borderColor: C.line }, historyTop: { flexDirection: 'row', alignItems: 'center' }, doneBadge: { borderRadius: 10, backgroundColor: C.greenSoft, paddingHorizontal: 8, paddingVertical: 5 }, doneText: { fontSize: 20, color: C.green2, fontWeight: '400' }, historyBottom: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }, historyItems: { color: C.muted, fontSize: 20, fontWeight: '400' }, historyTotal: { color: C.ink, fontWeight: '500', fontSize: 20 },
  empty: { alignItems: 'center', justifyContent: 'center', paddingVertical: 50, paddingHorizontal: 28 }, emptyIcon: { width: 54, height: 54, borderRadius: 27, backgroundColor: C.greenSoft, alignItems: 'center', justifyContent: 'center', marginBottom: 13 }, emptyIconText: { fontSize: 29.8, color: C.green }, emptyTitle: { color: C.ink, fontWeight: '500', fontSize: 20.8 }, emptyText: { color: C.muted, fontSize: 20, fontWeight: '400', textAlign: 'center', lineHeight: 24, marginTop: 6 }, emptyButton: { backgroundColor: C.green, paddingHorizontal: 18, paddingVertical: 11, borderRadius: 10, marginTop: 16 }, emptyButtonText: { color: C.white, fontWeight: '500', fontSize: 20 },
  settingsCard: { backgroundColor: C.white, borderWidth: 1, borderColor: C.line, borderRadius: 14, padding: 18, marginBottom: 12 }, settingsTitle: { fontSize: 20, fontWeight: '500', color: C.ink }, settingsText: { fontSize: 20, color: C.muted, fontWeight: '400', lineHeight: 24, marginTop: 6, marginBottom: 14 }, channelGrid: { flexDirection: 'row', gap: 8 }, channel: { flex: 1, borderWidth: 1, borderColor: C.line, backgroundColor: C.white, paddingVertical: 14, borderRadius: 12, alignItems: 'center' }, channelActive: { backgroundColor: C.green, borderColor: C.green }, channelText: { color: C.muted, fontSize: 20, fontWeight: '400' }, channelTextActive: { color: C.white }, infoRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: C.line }, infoLabel: { color: C.muted, fontSize: 20, fontWeight: '400' }, infoValue: { color: C.ink, fontSize: 20, fontWeight: '400', maxWidth: '62%', textAlign: 'right' }, note: { borderRadius: 12, padding: 14, backgroundColor: C.orangeSoft }, noteTitle: { color: C.green2, fontWeight: '500', fontSize: 20 }, noteText: { color: C.muted, fontSize: 20, fontWeight: '400', lineHeight: 24, marginTop: 5 },
  bottomNav: { position: 'absolute', left: 12, right: 12, bottom: Platform.OS === 'ios' ? 10 : 12, height: 98, borderRadius: 16, backgroundColor: C.white, borderWidth: 1, borderColor: C.line, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-around', paddingHorizontal: 4, shadowColor: '#1D4ED8', shadowOpacity: .06, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 2 }, navButton: { flex: 1, minHeight: 82, alignItems: 'center', justifyContent: 'center', gap: 3, paddingVertical: 7, paddingHorizontal: 2, borderRadius: 13 }, navButtonActive: { backgroundColor: C.blueSoft }, navIconWrap: { width: 44, height: 38, borderRadius: 12, alignItems: 'center', justifyContent: 'center' }, navIconWrapActive: { backgroundColor: '#DBEAFE' }, navIcon: { color: C.muted, fontSize: 31.1 }, navLabel: { color: C.muted, fontSize: 20, fontWeight: '400', textAlign: 'center' }, navActive: { color: C.green, fontWeight: '500' },
  modalPage: { flex: 1, backgroundColor: C.white }, modalContent: { padding: 20, paddingBottom: 42 }, modalHeader: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 20 }, modalTitle: { color: C.ink, fontSize: 28.6, fontWeight: '500' }, modalSub: { color: C.muted, fontSize: 20, fontWeight: '400', marginTop: 4 }, closeButton: { width: 42, height: 42, borderRadius: 10, backgroundColor: '#F3F4F6', alignItems: 'center', justifyContent: 'center' }, closeText: { color: C.ink, fontSize: 28.6, fontWeight: '400', marginTop: -2 }, field: { marginBottom: 14 }, fieldLabel: { color: C.muted, fontSize: 20, fontWeight: '400', letterSpacing: .7, marginBottom: 7 }, input: { height: 56, backgroundColor: C.white, borderWidth: 1, borderColor: C.line, borderRadius: 12, paddingHorizontal: 16, fontSize: 20, fontWeight: '400', color: C.ink }, itemsHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 5, marginBottom: 10 }, itemsTitle: { fontSize: 20.8, fontWeight: '500', color: C.ink }, itemsCount: { color: C.muted, fontSize: 20, fontWeight: '400' }, itemEditor: { backgroundColor: C.white, borderWidth: 1, borderColor: C.line, borderRadius: 14, padding: 16, marginBottom: 9 }, itemEditorTop: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 9 }, itemNumber: { color: C.green2, fontSize: 20, fontWeight: '400', letterSpacing: .7 }, removeText: { color: C.redDark, fontSize: 20, fontWeight: '400' }, suggestions: { gap: 6, paddingVertical: 8 }, suggestion: { borderRadius: 10, paddingVertical: 6, paddingHorizontal: 10, backgroundColor: '#F9FAFB', borderWidth: 1, borderColor: C.line }, suggestionActive: { backgroundColor: C.greenSoft, borderColor: C.blueLine }, suggestionText: { fontSize: 20, color: C.muted, fontWeight: '400' }, suggestionTextActive: { color: C.green2 }, twoColumns: { flexDirection: 'row', gap: 10, marginTop: 2 }, addItem: { height: 52, borderRadius: 12, borderWidth: 1, borderStyle: 'dashed', borderColor: C.blueLine, alignItems: 'center', justifyContent: 'center', marginBottom: 14 }, addItemText: { color: C.green2, fontSize: 20, fontWeight: '400' }, dailyTotal: { padding: 14, borderRadius: 12, backgroundColor: C.orangeSoft, borderWidth: 1, borderColor: C.blueLine, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }, dailyLabel: { color: C.muted, fontSize: 20, fontWeight: '400' }, dailyValue: { color: C.green2, fontSize: 20.8, fontWeight: '500' }, mainButton: { minHeight: 56, backgroundColor: C.green, borderRadius: 12, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 18 }, mainButtonText: { color: C.white, fontSize: 20, fontWeight: '500' },
  detailSummary: { backgroundColor: C.orangeSoft, borderWidth: 1, borderColor: C.blueLine, borderRadius: 14, padding: 20, marginBottom: 18 }, detailLabel: { color: C.green2, fontSize: 20, letterSpacing: 1, fontWeight: '400' }, detailTotal: { color: C.green2, fontSize: 35.1, fontWeight: '500', marginTop: 6 }, detailDate: { color: C.muted, fontSize: 20, fontWeight: '400', marginTop: 8 }, detailSectionHeader: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', marginTop: 4, marginBottom: 1 }, detailSectionCount: { color: C.muted, fontSize: 20, fontWeight: '400' }, paidSectionTotal: { color: C.green2, fontSize: 20, fontWeight: '400' }, detailItem: { backgroundColor: C.white, borderWidth: 1, borderColor: C.line, borderRadius: 14, padding: 16, marginTop: 8 }, detailItemTop: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 }, detailItemName: { color: C.ink, fontSize: 20, fontWeight: '500' }, detailItemSub: { color: C.muted, fontSize: 20, fontWeight: '400', marginTop: 4 }, detailItemTotal: { color: C.green2, fontSize: 20, fontWeight: '400' }, returnButton: { borderRadius: 12, backgroundColor: C.green, alignItems: 'center', paddingVertical: 15, marginTop: 12 }, returnButtonText: { color: C.white, fontWeight: '500', fontSize: 20 }, returnHistoryItem: { backgroundColor: '#F9FAFB', borderWidth: 1, borderColor: C.line, borderRadius: 12, padding: 13, marginTop: 8 }, returnHistoryAmount: { color: C.green2, fontSize: 20, fontWeight: '400' }, paidBadge: { alignSelf: 'flex-start', borderRadius: 10, backgroundColor: C.greenSoft, paddingHorizontal: 8, paddingVertical: 4, marginTop: 9 }, paidBadgeText: { color: C.green2, fontSize: 20, fontWeight: '400', letterSpacing: .4 }, receiptButton: { borderRadius: 10, borderWidth: 1, borderColor: C.green, alignItems: 'center', paddingVertical: 12, marginTop: 15 }, receiptButtonText: { color: C.green2, fontWeight: '500', fontSize: 20 },
  overlay: { flex: 1, backgroundColor: 'rgba(17,24,39,.35)', justifyContent: 'flex-end' }, returnSheet: { maxHeight: '89%', backgroundColor: C.white, padding: 18, paddingBottom: Platform.OS === 'ios' ? 32 : 20, borderTopLeftRadius: 16, borderTopRightRadius: 16 }, returnHint: { fontSize: 20, lineHeight: 24, color: C.muted, fontWeight: '400', marginBottom: 12 }, returnItemsScroll: { flexGrow: 0, marginBottom: 13 }, returnItemsList: { gap: 8 }, returnItemCard: { backgroundColor: C.white, borderRadius: 14, borderWidth: 1, borderColor: C.line, padding: 16 }, returnItemHeading: { flexDirection: 'row', gap: 10, alignItems: 'flex-start', marginBottom: 9 }, returnItemMeta: { color: C.muted, fontSize: 20, fontWeight: '400', marginTop: 4 }, returnMax: { color: C.green2, fontSize: 20, fontWeight: '400' },
  receiptPaper: { backgroundColor: C.white, borderWidth: 1, borderColor: C.line, borderRadius: 14, padding: 18, marginBottom: 13 }, receiptHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingBottom: 14, borderBottomWidth: 1, borderStyle: 'dashed', borderBottomColor: C.line }, receiptNumber: { color: C.muted, fontSize: 20, fontWeight: '400' }, receiptCustomer: { alignItems: 'center', paddingVertical: 17 }, receiptName: { color: C.ink, fontSize: 20, fontWeight: '500' }, receiptDate: { color: C.muted, fontSize: 20, fontWeight: '400', marginTop: 7 }, receiptSectionTitle: { color: C.green2, fontSize: 20, letterSpacing: .8, fontWeight: '400', marginBottom: 2 }, receiptRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 11, borderTopWidth: 1, borderTopColor: C.line }, receiptItemName: { color: C.ink, fontSize: 20, fontWeight: '400' }, receiptItemSub: { color: C.muted, fontSize: 20, fontWeight: '400', marginTop: 4 }, receiptPaidAmount: { color: C.green2, fontWeight: '400', fontSize: 20 }, receiptCurrentBlock: { marginTop: 12, backgroundColor: C.orangeSoft, borderRadius: 10, padding: 12, borderWidth: 1, borderColor: C.blueLine }, receiptCurrentTitle: { color: C.green2, fontSize: 20, letterSpacing: .45, fontWeight: '400', marginBottom: 7 }, receiptOpenRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 5 }, receiptOpenAmount: { color: C.green2, fontWeight: '400', fontSize: 20 }, receiptCurrentTotal: { color: C.green2, fontWeight: '500', fontSize: 20.8, textAlign: 'right', paddingTop: 8, marginTop: 4, borderTopWidth: 1, borderTopColor: C.blueLine }, receiptReminder: { color: C.muted, fontSize: 20, fontWeight: '400', lineHeight: 24, marginTop: 10 }, receiptGrand: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 15, marginTop: 13, borderTopWidth: 1, borderTopColor: C.ink }, receiptGrandLabel: { color: C.ink, fontSize: 20, fontWeight: '500', maxWidth: '56%' }, receiptGrandValue: { color: C.green2, fontSize: 23.3, fontWeight: '500' }, receiptActionGrid: { flexDirection: 'row', gap: 8, marginBottom: 13 }, receiptAction: { flex: 1, minHeight: 78, paddingVertical: 11, paddingHorizontal: 8, borderWidth: 1, borderColor: C.green, borderRadius: 10, alignItems: 'center', justifyContent: 'center', gap: 5, backgroundColor: C.white }, receiptActionPrimary: { backgroundColor: C.green, borderColor: C.green }, receiptActionOrange: { borderColor: C.blueLine, backgroundColor: C.orangeSoft }, receiptActionIcon: { color: C.green2, fontSize: 22.1, fontWeight: '400' }, receiptActionLabel: { color: C.green2, fontSize: 20, textAlign: 'center', fontWeight: '400' }, shareHint: { textAlign: 'center', color: C.muted, fontSize: 20, fontWeight: '400', marginBottom: 10 }, shareButton: { minHeight: 44, borderRadius: 10, borderWidth: 1, borderColor: C.line, alignItems: 'center', justifyContent: 'center', backgroundColor: C.white }, shareButtonText: { color: C.green2, fontSize: 20, fontWeight: '400' },
});

const installS = StyleSheet.create({
  installCard: { minHeight: 74, padding: 14, backgroundColor: C.white, borderRadius: 12, borderWidth: 1, borderColor: C.line, flexDirection: 'row', alignItems: 'center', marginBottom: 10 },
  installIcon: { width: 42, height: 42, borderRadius: 12, backgroundColor: C.orangeSoft, alignItems: 'center', justifyContent: 'center', marginRight: 11 },
  installArrow: { color: C.green2, fontSize: 32.5, fontWeight: '400', marginLeft: 8 },
  installOverlay: { flex: 1, backgroundColor: 'rgba(17,24,39,.35)', alignItems: 'center', justifyContent: 'center', padding: 22 },
  installModal: { width: '100%', maxWidth: 420, backgroundColor: C.white, borderRadius: 16, borderWidth: 1, borderColor: C.line, padding: 20 },
  installModalIcon: { width: 54, height: 54, borderRadius: 16, backgroundColor: C.orangeSoft, alignItems: 'center', justifyContent: 'center', marginBottom: 14 },
  installModalTitle: { color: C.ink, fontSize: 24.6, fontWeight: '500', marginBottom: 10 },
  installModalText: { color: C.muted, fontSize: 20, fontWeight: '400', lineHeight: 24, marginBottom: 8 },
  installCloseButton: { minHeight: 44, borderRadius: 10, backgroundColor: C.green, alignItems: 'center', justifyContent: 'center', marginTop: 10 },
  installCloseText: { color: C.white, fontSize: 20, fontWeight: '500' },
  pendingPanel: { backgroundColor: '#FFF7ED', borderWidth: 1, borderColor: '#FED7AA', borderRadius: 12, padding: 14, marginBottom: 18 }, pendingPanelHead: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }, pendingPanelTitle: { color: '#9A3412', fontSize: 22, fontWeight: '500' }, pendingPanelSub: { color: '#C2410C', fontSize: 18, marginTop: 4 }, pendingPanelTotal: { color: '#C2410C', fontSize: 22, fontWeight: '500' }, pendingPanelRow: { flexDirection: 'row', alignItems: 'center', borderTopWidth: 1, borderTopColor: '#FED7AA', paddingTop: 10, marginTop: 10, gap: 10 }, pendingPanelAmount: { color: '#C2410C', fontSize: 20, fontWeight: '500' },
  pendingPaymentCard: { backgroundColor: '#FFF7ED', borderColor: '#FED7AA' }, pendingPaymentFooter: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 9 }, paidConfirmButton: { borderRadius: 10, backgroundColor: C.orange, paddingHorizontal: 14, paddingVertical: 8 }, paidConfirmText: { color: C.white, fontSize: 18, fontWeight: '500' },
  smsQueueCard: { backgroundColor: C.white, borderWidth: 1, borderColor: C.line, borderRadius: 12, padding: 14, marginTop: 10 }, smsQueueHead: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 }, smsQueueStatus: { fontSize: 16, fontWeight: '500', letterSpacing: .3 }, smsQueueMessage: { color: C.ink, fontSize: 19, lineHeight: 26, marginTop: 10 }, smsQueueError: { color: C.redDark, fontSize: 18, marginTop: 8 }, smsQueueSend: { alignSelf: 'flex-start', borderRadius: 10, backgroundColor: C.green, paddingHorizontal: 16, paddingVertical: 9, marginTop: 12 }, smsQueueSendText: { color: C.white, fontSize: 18, fontWeight: '500' },
});

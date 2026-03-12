// Constants - Enum values, status labels, role labels
// All enum values match the PostgreSQL ENUM types defined in the database schema.
// Vietnamese labels are used for UI display per NFR 6.4.3.

// --- Table Status ---

export const TABLE_STATUS = {
  EMPTY: 'empty',
  SERVING: 'serving',
  AWAITING_PAYMENT: 'awaiting_payment',
  PAID: 'paid'
};

export const TABLE_STATUS_LABELS = {
  [TABLE_STATUS.EMPTY]: 'Trong',
  [TABLE_STATUS.SERVING]: 'Dang phuc vu',
  [TABLE_STATUS.AWAITING_PAYMENT]: 'Cho thanh toan',
  [TABLE_STATUS.PAID]: 'Da thanh toan'
};

// --- Order Status ---

export const ORDER_STATUS = {
  ACTIVE: 'active',
  COMPLETED: 'completed',
  FINALIZED: 'finalized',
  CANCELLED: 'cancelled'
};

export const ORDER_STATUS_LABELS = {
  [ORDER_STATUS.ACTIVE]: 'Dang hoat dong',
  [ORDER_STATUS.COMPLETED]: 'Hoan thanh',
  [ORDER_STATUS.FINALIZED]: 'Da xuat hoa don',
  [ORDER_STATUS.CANCELLED]: 'Da huy'
};

// --- Bill Status ---

export const BILL_STATUS = {
  DRAFT: 'draft',
  FINALIZED: 'finalized',
  PRINTED: 'printed',
  PENDING_PRINT: 'pending_print'
};

export const BILL_STATUS_LABELS = {
  [BILL_STATUS.DRAFT]: 'Nhap',
  [BILL_STATUS.FINALIZED]: 'Da xuat',
  [BILL_STATUS.PRINTED]: 'Da in',
  [BILL_STATUS.PENDING_PRINT]: 'Cho in'
};

// --- Payment Method ---

export const PAYMENT_METHOD = {
  CASH: 'cash',
  CARD: 'card',
  TRANSFER: 'transfer'
};

export const PAYMENT_METHOD_LABELS = {
  [PAYMENT_METHOD.CASH]: 'Tien mat',
  [PAYMENT_METHOD.CARD]: 'The',
  [PAYMENT_METHOD.TRANSFER]: 'Chuyen khoan'
};

// --- User Roles ---

export const USER_ROLES = {
  OWNER: 'owner',
  MANAGER: 'manager',
  STAFF: 'staff',
  CASHIER: 'cashier',
  WAREHOUSE: 'warehouse'
};

export const USER_ROLES_LABELS = {
  [USER_ROLES.OWNER]: 'Chu cua hang',
  [USER_ROLES.MANAGER]: 'Quan ly',
  [USER_ROLES.STAFF]: 'Nhan vien',
  [USER_ROLES.CASHIER]: 'Thu ngan',
  [USER_ROLES.WAREHOUSE]: 'Thu kho'
};

// --- Table Shape ---

export const TABLE_SHAPE = {
  SQUARE: 'square',
  ROUND: 'round',
  RECTANGLE: 'rectangle'
};

// --- Status Colors (mapped to CSS custom properties) ---

export const STATUS_COLORS = {
  [TABLE_STATUS.EMPTY]: 'var(--color-empty)',
  [TABLE_STATUS.SERVING]: 'var(--color-serving)',
  [TABLE_STATUS.AWAITING_PAYMENT]: 'var(--color-awaiting-payment)',
  [TABLE_STATUS.PAID]: 'var(--color-paid)'
};

CREATE TABLE IF NOT EXISTS host_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    host_id TEXT NOT NULL,
    auth_private_key TEXT NOT NULL,
    auth_certificate TEXT NOT NULL,
    auth_version TEXT NOT NULL DEFAULT 'X002',
    enc_private_key TEXT NOT NULL,
    enc_certificate TEXT NOT NULL,
    enc_version TEXT NOT NULL DEFAULT 'E002'
);

CREATE TABLE IF NOT EXISTS subscribers (
    partner_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'NEW',
    signature_version TEXT,
    signature_certificate TEXT,
    authentication_version TEXT,
    authentication_certificate TEXT,
    encryption_version TEXT,
    encryption_certificate TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (partner_id, user_id)
);

CREATE TABLE IF NOT EXISTS nonces (
    nonce TEXT PRIMARY KEY,
    timestamp TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS transactions (
    transaction_id TEXT PRIMARY KEY,
    partner_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    host_id TEXT NOT NULL,
    direction TEXT NOT NULL DEFAULT 'download',
    phase TEXT NOT NULL DEFAULT 'Initialisation',
    order_type TEXT NOT NULL,
    num_segments INTEGER NOT NULL DEFAULT 1,
    current_segment INTEGER NOT NULL DEFAULT 1,
    segments TEXT NOT NULL,
    transaction_key TEXT NOT NULL,
    enc_key_digest TEXT NOT NULL,
    signature_data TEXT,
    service_name TEXT,
    msg_name TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS download_data (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    service_name TEXT NOT NULL,
    msg_name TEXT,
    content TEXT NOT NULL,
    content_type TEXT NOT NULL DEFAULT 'text',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(service_name, msg_name)
);

CREATE TABLE IF NOT EXISTS bank_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    blz TEXT NOT NULL,
    name TEXT NOT NULL,
    bic TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS persons (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    external_id TEXT UNIQUE,
    name TEXT NOT NULL,
    address_line1 TEXT,
    address_line2 TEXT,
    country TEXT NOT NULL DEFAULT 'DE',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    person_id INTEGER NOT NULL REFERENCES persons(id) ON DELETE RESTRICT,
    iban TEXT NOT NULL UNIQUE,
    account_number TEXT NOT NULL,
    currency TEXT NOT NULL DEFAULT 'EUR',
    name TEXT NOT NULL,
    current_balance_cents INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS partner_account_access (
    partner_id TEXT NOT NULL,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    PRIMARY KEY (partner_id, account_id)
);

CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    amount_cents INTEGER NOT NULL,
    currency TEXT NOT NULL DEFAULT 'EUR',
    value_date TEXT NOT NULL,
    booking_date TEXT NOT NULL,
    counterparty_name TEXT,
    counterparty_iban TEXT,
    counterparty_bic TEXT,
    remittance_info TEXT,
    end_to_end_id TEXT,
    transaction_code TEXT NOT NULL DEFAULT 'NTRF',
    source_pain_id INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_bookings_account_value_date
    ON bookings(account_id, value_date, id);

CREATE TABLE IF NOT EXISTS uploaded_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    partner_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    service_name TEXT NOT NULL,
    msg_name TEXT,
    raw_content TEXT NOT NULL,
    processed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS protocol_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    root_element TEXT,
    order_type TEXT,
    partner_id TEXT,
    user_id TEXT,
    transaction_id TEXT,
    transaction_phase TEXT,
    return_code TEXT,
    request_xml TEXT NOT NULL,
    response_xml TEXT NOT NULL,
    duration_ms INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    partner_id TEXT,
    user_id TEXT,
    order_type TEXT,
    result_code TEXT,
    details TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- EBICS order IDs (OrderIDType: [A-Z][A-Z0-9]{3}), allocated per partner for uploads and key management orders
CREATE TABLE IF NOT EXISTS order_id_counters (
    partner_id TEXT PRIMARY KEY,
    next INTEGER NOT NULL DEFAULT 0
);

-- Bank-side order lifecycle steps, the source of the HAC customer protocol (docs/HAC_PLAN.md)
CREATE TABLE IF NOT EXISTS hac_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    partner_id TEXT NOT NULL,
    user_id TEXT,
    order_id TEXT NOT NULL,
    action TEXT NOT NULL,
    admin_order_type TEXT NOT NULL,
    service_name TEXT,
    service_option TEXT,
    scope TEXT,
    container_type TEXT,
    msg_name TEXT,
    order_id_ref TEXT,
    admin_order_type_ref TEXT,
    reason_code TEXT,
    additional_info TEXT NOT NULL DEFAULT '[]',
    event_at TEXT NOT NULL,
    uploaded_order_id INTEGER
);

CREATE INDEX IF NOT EXISTS idx_hac_events_partner_time ON hac_events(partner_id, event_at, id);

-- Credit transfer orders received via pain.001 uploads, one row per PmtInf (Sammler)
CREATE TABLE IF NOT EXISTS payment_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id TEXT NOT NULL,
    uploaded_order_id INTEGER,
    partner_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    service_name TEXT NOT NULL,
    service_option TEXT,
    msg_name TEXT NOT NULL,
    msg_id TEXT NOT NULL,
    pmt_inf_id TEXT NOT NULL,
    debtor_name TEXT,
    debtor_iban TEXT,
    requested_eds INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS payment_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    payment_order_id INTEGER NOT NULL REFERENCES payment_orders(id) ON DELETE CASCADE,
    end_to_end_id TEXT,
    creditor_name TEXT,
    creditor_iban TEXT,
    creditor_bic TEXT,
    amount_cents INTEGER NOT NULL,
    currency TEXT NOT NULL DEFAULT 'EUR',
    remittance_info TEXT,
    vop_status TEXT NOT NULL DEFAULT 'RVNA',
    vop_corrected_name TEXT,
    debit_booking_id INTEGER,
    credit_booking_id INTEGER
);

-- pain.002 payment status history per payment order (source of PSR downloads)
CREATE TABLE IF NOT EXISTS payment_status_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    payment_order_id INTEGER NOT NULL REFERENCES payment_orders(id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    reason_code TEXT,
    additional_info TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Items already fetched by a partner via a download without DateRange (marked on positive receipt)
CREATE TABLE IF NOT EXISTS deliveries (
    partner_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    item_key TEXT NOT NULL,
    delivered_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (partner_id, kind, item_key)
);

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

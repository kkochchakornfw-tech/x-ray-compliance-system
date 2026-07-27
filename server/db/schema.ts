import {
  pgTable,
  uuid,
  text,
  jsonb,
  boolean,
  timestamp,
  foreignKey,
  date,
  integer,
} from "drizzle-orm/pg-core";

export const forms = pgTable("forms", {
  id: uuid().defaultRandom().primaryKey().notNull(),
  title: text().notNull(),
  description: text().notNull(),
  questions: jsonb().notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at", { mode: "string" }).defaultNow().notNull(),
  shifts: jsonb(),
  department: text(),
  sortOrder: integer("sort_order").default(0).notNull(),
});

export const bundles = pgTable("bundles", {
  id: uuid().defaultRandom().primaryKey().notNull(),
  name: text().notNull(),
  department: text().notNull(),
  formIds: jsonb("form_ids").notNull(),
  sortOrder: integer("sort_order").default(0).notNull(),
});

export const config = pgTable("config", {
  id: text().primaryKey().notNull(),
  settings: jsonb().notNull(),
  announcements: jsonb().notNull(),
});

export const schedules = pgTable(
  "schedules",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    date: date().notNull(),
    shift: text().notNull(),
    staffId: uuid("staff_id").notNull(),
    formId: uuid("form_id"),
    location: text(),
    supervisorId: uuid("supervisor_id").notNull(),
    status: text().notNull(),
    slaAlertSent: boolean("sla_alert_sent").default(false).notNull(),
    supervisorAlertSent: boolean("supervisor_alert_sent")
      .default(false)
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.staffId],
      foreignColumns: [users.id],
      name: "schedules_staff_id_users_id_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.formId],
      foreignColumns: [forms.id],
      name: "schedules_form_id_forms_id_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.supervisorId],
      foreignColumns: [users.id],
      name: "schedules_supervisor_id_users_id_fk",
    }).onDelete("cascade"),
  ],
);

export const submissions = pgTable(
  "submissions",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    scheduleId: uuid("schedule_id"),
    staffId: uuid("staff_id").notNull(),
    formId: uuid("form_id").notNull(),
    submittedAt: timestamp("submitted_at", { mode: "string" })
      .defaultNow()
      .notNull(),
    data: jsonb().notNull(),
    photos: jsonb().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.scheduleId],
      foreignColumns: [schedules.id],
      name: "submissions_schedule_id_schedules_id_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.staffId],
      foreignColumns: [users.id],
      name: "submissions_staff_id_users_id_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.formId],
      foreignColumns: [forms.id],
      name: "submissions_form_id_forms_id_fk",
    }).onDelete("cascade"),
  ],
);

export const users = pgTable("users", {
  id: uuid().defaultRandom().primaryKey().notNull(),
  employeeId: text("employee_id").notNull(),
  name: text().notNull(),
  department: text().notNull(),
  email: text().notNull(),
  role: text().notNull(),
  pinHash: text("pin_hash"),
  requirePasswordChange: boolean("require_password_change")
    .default(true)
    .notNull(),
  sortOrder: integer("sort_order").default(0).notNull(),
});

export const alerts = pgTable(
  "alerts",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    type: text().notNull(),
    message: text().notNull(),
    timestamp: timestamp({ mode: "string" }).defaultNow().notNull(),
    isRead: boolean("is_read").default(false).notNull(),
    staffId: uuid("staff_id"),
    formId: uuid("form_id"),
  },
  (table) => [
    foreignKey({
      columns: [table.staffId],
      foreignColumns: [users.id],
      name: "alerts_staff_id_users_id_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.formId],
      foreignColumns: [forms.id],
      name: "alerts_form_id_forms_id_fk",
    }).onDelete("cascade"),
  ],
);

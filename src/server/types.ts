export const Role = {
  CUSTOMER: "CUSTOMER",
  ADMIN: "ADMIN",
} as const;
export type Role = (typeof Role)[keyof typeof Role];

export const UserStatus = {
  ACTIVE: "ACTIVE",
  SUSPENDED: "SUSPENDED",
} as const;
export type UserStatus = (typeof UserStatus)[keyof typeof UserStatus];

export const ApplicationStatus = {
  DRAFT: "DRAFT",
  SUBMITTED: "SUBMITTED",
  UNDER_REVIEW: "UNDER_REVIEW",
  APPROVED: "APPROVED",
  REJECTED: "REJECTED",
} as const;
export type ApplicationStatus = (typeof ApplicationStatus)[keyof typeof ApplicationStatus];

export const LoanStatus = {
  PENDING_DISBURSEMENT: "PENDING_DISBURSEMENT",
  DISBURSED: "DISBURSED",
  PAID: "PAID",
  DEFAULTED: "DEFAULTED",
  WRITTEN_OFF: "WRITTEN_OFF",
} as const;
export type LoanStatus = (typeof LoanStatus)[keyof typeof LoanStatus];

export const PaymentStatus = {
  PENDING: "PENDING",
  CONFIRMED: "CONFIRMED",
  REJECTED: "REJECTED",
  REVERSED: "REVERSED",
} as const;
export type PaymentStatus = (typeof PaymentStatus)[keyof typeof PaymentStatus];

export const DisbursementStatus = {
  PENDING: "PENDING",
  INITIATED: "INITIATED",
  CONFIRMED: "CONFIRMED",
  CANCELLED: "CANCELLED",
} as const;
export type DisbursementStatus = (typeof DisbursementStatus)[keyof typeof DisbursementStatus];

export const InstallmentStatus = {
  PENDING: "PENDING",
  PAID: "PAID",
} as const;
export type InstallmentStatus = (typeof InstallmentStatus)[keyof typeof InstallmentStatus];

export const DelinquencyStatus = {
  CURRENT: "CURRENT",
  DUE_SOON: "DUE_SOON",
  DUE_TODAY: "DUE_TODAY",
  OVERDUE: "OVERDUE",
  DEFAULT: "DEFAULT",
  PAID: "PAID",
} as const;
export type DelinquencyStatus = (typeof DelinquencyStatus)[keyof typeof DelinquencyStatus];

export const RiskLevel = {
  LOW: "LOW",
  MEDIUM: "MEDIUM",
  HIGH: "HIGH",
} as const;
export type RiskLevel = (typeof RiskLevel)[keyof typeof RiskLevel];

export const NotificationStatus = {
  PENDING: "PENDING",
  SENT: "SENT",
  READ: "READ",
  FAILED: "FAILED",
} as const;
export type NotificationStatus = (typeof NotificationStatus)[keyof typeof NotificationStatus];

export const AuditAction = {
  USER_CREATED: "USER_CREATED",
  LOAN_REQUESTED: "LOAN_REQUESTED",
  LOAN_APPROVED: "LOAN_APPROVED",
  LOAN_REJECTED: "LOAN_REJECTED",
  LOAN_DISBURSEMENT_INITIATED: "LOAN_DISBURSEMENT_INITIATED",
  LOAN_DISBURSED: "LOAN_DISBURSED",
  PAYMENT_CREATED: "PAYMENT_CREATED",
  PAYMENT_CONFIRMED: "PAYMENT_CONFIRMED",
  PAYMENT_REJECTED: "PAYMENT_REJECTED",
  PAYMENT_REVERSED: "PAYMENT_REVERSED",
  PAYMENT_RECEIPT_UPLOADED: "PAYMENT_RECEIPT_UPLOADED",
  SCORE_CALCULATED: "SCORE_CALCULATED",
  LIMIT_CHANGED: "LIMIT_CHANGED",
  LOAN_STATUS_CHANGED: "LOAN_STATUS_CHANGED",
  DELINQUENCY_RECALCULATED: "DELINQUENCY_RECALCULATED",
  CONFIG_CHANGED: "CONFIG_CHANGED",
} as const;
export type AuditAction = (typeof AuditAction)[keyof typeof AuditAction];

export const TermFrequency = {
  WEEKLY: "WEEKLY",
  BIWEEKLY: "BIWEEKLY",
  MONTHLY: "MONTHLY",
} as const;
export type TermFrequency = (typeof TermFrequency)[keyof typeof TermFrequency];

export const ActorType = {
  SYSTEM: "SYSTEM",
  USER: "USER",
  ADMIN: "ADMIN",
} as const;
export type ActorType = (typeof ActorType)[keyof typeof ActorType];

export const Currency = {
  COP: "COP",
} as const;
export type Currency = (typeof Currency)[keyof typeof Currency];
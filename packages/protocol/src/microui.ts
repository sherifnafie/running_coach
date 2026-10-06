import { z } from 'zod';
import { IsoDateTime } from './common';

/**
 * Micro-UI (SPEC §9.3, Appendix C §C.3): declarative quick replies / forms / notification actions
 * attached to coach messages. Model-facing → snake_case. Rendered by the shell (chat + push).
 */
export const QuickReply = z.object({
  label: z.string().min(1).max(24),
  value: z.string().min(1).max(200),
});
export type QuickReply = z.infer<typeof QuickReply>;

const FieldBase = { id: z.string().min(1).max(40), label: z.string().min(1).max(120) };

export const FormField = z.discriminatedUnion('type', [
  z.object({
    ...FieldBase,
    type: z.literal('scale'),
    min: z.number(),
    max: z.number(),
    step: z.number().positive().optional(),
    anchors: z.record(z.string(), z.string()).optional(),
  }),
  z.object({
    ...FieldBase,
    type: z.literal('choice'),
    options: z.array(z.object({ label: z.string(), value: z.string() })).min(1).max(12),
  }),
  z.object({
    ...FieldBase,
    type: z.literal('multi_choice'),
    options: z.array(z.object({ label: z.string(), value: z.string() })).min(1).max(12),
  }),
  z.object({
    ...FieldBase,
    type: z.literal('number'),
    unit: z.string().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
  }),
  z.object({
    ...FieldBase,
    type: z.literal('text'),
    multiline: z.boolean().optional(),
    max_len: z.number().int().positive().max(4000).optional(),
  }),
  z.object({ ...FieldBase, type: z.literal('date') }),
  z.object({ ...FieldBase, type: z.literal('time') }),
  z.object({ ...FieldBase, type: z.literal('body_map'), multi: z.boolean().optional() }),
]);
export type FormField = z.infer<typeof FormField>;

export const MicroForm = z.object({
  id: z.string().min(1).max(40),
  title: z.string().max(120).optional(),
  fields: z.array(FormField).min(1).max(12),
  submit_label: z.string().max(24).optional(),
});
export type MicroForm = z.infer<typeof MicroForm>;

export const NotificationAction = z.object({
  label: z.string().min(1).max(16),
  value: z.string().min(1).max(200),
});

export const MicroUI = z.object({
  quick_replies: z.array(QuickReply).max(6).optional(),
  form: MicroForm.optional(),
  notification_actions: z.array(NotificationAction).max(3).optional(),
  expires_at: IsoDateTime.optional(),
});
export type MicroUI = z.infer<typeof MicroUI>;

/** Body-map region ids rendered by the shell and the UI kit's <rc-body-map>. */
export const BODY_REGIONS = [
  'head', 'neck', 'left_shoulder', 'right_shoulder', 'chest', 'upper_back', 'lower_back', 'abdomen',
  'left_hip', 'right_hip', 'left_glute', 'right_glute', 'groin',
  'left_quad', 'right_quad', 'left_hamstring', 'right_hamstring', 'left_itb', 'right_itb',
  'left_knee', 'right_knee', 'left_shin', 'right_shin', 'left_calf', 'right_calf',
  'left_achilles', 'right_achilles', 'left_ankle', 'right_ankle', 'left_heel', 'right_heel',
  'left_arch', 'right_arch', 'left_forefoot', 'right_forefoot', 'left_toes', 'right_toes',
] as const;
export type BodyRegion = (typeof BODY_REGIONS)[number];

// app/components/Shipping/PackagingModals.tsx
//
// Le modali delle tabelle di imballo: categoria, regola, conferma di
// eliminazione. Nessuna si chiude da sola al salvataggio: la chiude la pagina
// quando il server conferma, e se rifiuta resta aperta con il motivo.
//
// Il controllo locale usa le stesse funzioni del server (packaging-edit) sulla
// configurazione mostrata: il merchant vede subito un nome doppio o una
// seconda regola "tutto il resto", senza aspettare la risposta.

import { useState } from 'react';
import { BlockStack, Checkbox, Modal, Select, Text, TextField } from '@shopify/polaris';
import { useT } from '~/lib/i18n/context';
import type { FallbackRule, PackagingCategory } from '~/lib/shipping/types';
import { testoDiErrore } from './feedback';
import { saveCategory, saveRule } from './packaging-edit';

interface Current {
  categories: PackagingCategory[];
  rules: FallbackRule[];
}

function ServerOrLocalError({ local, server }: { local: string | null; server: string | null }) {
  const message = local ?? server;
  if (!message) return null;
  return (
    <Text as="p" tone="critical">
      {message}
    </Text>
  );
}

interface CategoryModalProps {
  current: Current;
  /** La categoria da modificare; null per aggiungerne una. */
  category: PackagingCategory | null;
  onClose: () => void;
  onSave: (data: { originalName: string | null; name: string; cost: string }) => void;
  isSaving: boolean;
  serverError: string | null;
}

export function CategoryModal({ current, category, onClose, onSave, isSaving, serverError }: CategoryModalProps) {
  const t = useT();
  const c = t.shipping.packaging.categories;
  const [name, setName] = useState(category?.name ?? '');
  const [cost, setCost] = useState(category ? String(category.cost) : '');
  const [localError, setLocalError] = useState<string | null>(null);

  const handleSave = () => {
    const parsed = cost.trim() === '' ? Number.NaN : Number(cost);
    const esito = saveCategory(current, category?.name ?? null, { name, cost: parsed });
    if (esito.error !== null) {
      setLocalError(testoDiErrore(esito.error, t) ?? t.shipping.packaging.saveError);
      return;
    }
    setLocalError(null);
    onSave({ originalName: category?.name ?? null, name: name.trim(), cost });
  };

  const costError = localError === t.shipping.packaging.errors.categoryCostNegative;

  return (
    <Modal
      open
      onClose={onClose}
      title={category ? c.editTitle(category.name) : c.addTitle}
      primaryAction={{ content: t.shipping.packaging.save, onAction: handleSave, loading: isSaving }}
      secondaryActions={[{ content: t.shipping.packaging.cancel, onAction: onClose }]}
    >
      <Modal.Section>
        <BlockStack gap="400">
          <TextField
            label={t.shipping.packaging.categoryNameLabel}
            value={name}
            onChange={(v) => {
              setName(v);
              setLocalError(null);
            }}
            placeholder={t.shipping.packaging.categoryNamePlaceholder}
            helpText={c.nameHelp}
            autoComplete="off"
            error={localError && !costError ? localError : undefined}
          />
          <TextField
            label={t.shipping.packaging.categoryCostLabel}
            type="number"
            value={cost}
            onChange={(v) => {
              setCost(v);
              setLocalError(null);
            }}
            placeholder={t.shipping.packaging.categoryCostPlaceholder}
            helpText={c.costHelp}
            autoComplete="off"
            min={0}
            step={0.01}
            error={costError ? localError ?? undefined : undefined}
          />
          <ServerOrLocalError local={null} server={localError ? null : serverError} />
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}

interface RuleModalProps {
  current: Current;
  /** La posizione della regola da modificare; null per aggiungerne una. */
  index: number | null;
  onClose: () => void;
  onSave: (data: { index: number | null; weightMaxKg: string; category: string }) => void;
  isSaving: boolean;
  serverError: string | null;
}

export function RuleModal({ current, index, onClose, onSave, isSaving, serverError }: RuleModalProps) {
  const t = useT();
  const r = t.shipping.packaging.rules;
  const rule = index !== null ? current.rules[index] : undefined;

  const [unlimited, setUnlimited] = useState(rule ? rule.weightMaxKg === null : false);
  const [weight, setWeight] = useState(rule && rule.weightMaxKg !== null ? String(rule.weightMaxKg) : '');
  const [category, setCategory] = useState(rule?.category ?? current.categories[0]?.name ?? '');
  const [localError, setLocalError] = useState<string | null>(null);

  const handleSave = () => {
    const weightMaxKg = unlimited ? null : weight.trim() === '' ? Number.NaN : Number(weight);
    const esito = saveRule(current, index, { weightMaxKg, category });
    if (esito.error !== null) {
      setLocalError(testoDiErrore(esito.error, t) ?? t.shipping.packaging.saveError);
      return;
    }
    setLocalError(null);
    onSave({ index, weightMaxKg: unlimited ? '' : weight, category });
  };

  const weightError = localError === t.shipping.packaging.errors.ruleWeightNegative;

  return (
    <Modal
      open
      onClose={onClose}
      title={index === null ? r.addTitle : r.editTitle}
      primaryAction={{ content: t.shipping.packaging.save, onAction: handleSave, loading: isSaving }}
      secondaryActions={[{ content: t.shipping.packaging.cancel, onAction: onClose }]}
    >
      <Modal.Section>
        <BlockStack gap="400">
          <Checkbox
            label={r.unlimitedLabel}
            helpText={r.unlimitedHelp}
            checked={unlimited}
            onChange={(v) => {
              setUnlimited(v);
              setLocalError(null);
            }}
          />
          {!unlimited && (
            <TextField
              label={t.shipping.packaging.ruleWeightLabel}
              type="number"
              value={weight}
              onChange={(v) => {
                setWeight(v);
                setLocalError(null);
              }}
              placeholder={t.shipping.packaging.ruleWeightPlaceholder}
              autoComplete="off"
              min={0}
              step={0.001}
              error={weightError ? localError ?? undefined : undefined}
            />
          )}
          <Select
            label={t.shipping.packaging.ruleCategoryLabel}
            options={current.categories.map((cat) => ({ label: cat.name, value: cat.name }))}
            value={category}
            onChange={(v) => {
              setCategory(v);
              setLocalError(null);
            }}
          />
          <ServerOrLocalError local={weightError ? null : localError} server={localError ? null : serverError} />
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}

interface ConfirmDeleteModalProps {
  title: string;
  body: string;
  onClose: () => void;
  onConfirm: () => void;
  isDeleting: boolean;
  serverError: string | null;
}

/** La conferma prima di eliminare: se il server blocca, il motivo resta qui. */
export function ConfirmDeleteModal({ title, body, onClose, onConfirm, isDeleting, serverError }: ConfirmDeleteModalProps) {
  const t = useT();
  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      primaryAction={{
        content: t.shipping.packaging.confirmDelete,
        onAction: onConfirm,
        destructive: true,
        loading: isDeleting,
      }}
      secondaryActions={[{ content: t.shipping.packaging.cancel, onAction: onClose }]}
    >
      <Modal.Section>
        <BlockStack gap="300">
          <Text as="p">{body}</Text>
          <ServerOrLocalError local={null} server={serverError} />
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}

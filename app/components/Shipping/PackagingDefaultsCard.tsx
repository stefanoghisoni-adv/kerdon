import { useState } from 'react';
import { BlockStack, Box, Button, Card, Text, TextField } from '@shopify/polaris';
import { useT } from '~/lib/i18n/context';

interface PackagingDefaultsCardProps {
  initialDefaultWeight: number | null;
  initialReturnCost: number | null;
  onSave: (data: { defaultWeightPerItemKg: string; returnCost: string }) => void;
  isSaving: boolean;
}

/** Valido se vuoto o un numero finito non negativo. */
const valido = (v: string) => v.trim() === '' || (Number.isFinite(Number(v)) && Number(v) >= 0);

/** Peso di default per articolo e costo dei resi, con il loro Salva. */
export function PackagingDefaultsCard({
  initialDefaultWeight,
  initialReturnCost,
  onSave,
  isSaving,
}: PackagingDefaultsCardProps) {
  const t = useT();
  const p = t.shipping.packaging;
  const [defaultWeight, setDefaultWeight] = useState(initialDefaultWeight !== null ? String(initialDefaultWeight) : '');
  const [returnCost, setReturnCost] = useState(initialReturnCost !== null ? String(initialReturnCost) : '');

  const weightOk = valido(defaultWeight);
  const returnOk = valido(returnCost);

  return (
    <Card>
      <BlockStack gap="400">
        <Text as="h2" variant="headingMd">
          {p.defaults.title}
        </Text>
        <TextField
          label={p.defaultWeightLabel}
          type="number"
          value={defaultWeight}
          onChange={setDefaultWeight}
          placeholder={p.defaultWeightPlaceholder}
          helpText={p.defaultWeightHelp}
          autoComplete="off"
          min={0}
          step={0.001}
          error={weightOk ? undefined : p.errors.invalidDefaultWeight}
        />
        <TextField
          label={p.returnCostLabel}
          type="number"
          value={returnCost}
          onChange={setReturnCost}
          placeholder={p.returnCostPlaceholder}
          helpText={p.returnCostHelp}
          autoComplete="off"
          min={0}
          step={0.01}
          error={returnOk ? undefined : p.errors.invalidReturnCost}
        />
        <Box>
          <Button
            variant="primary"
            onClick={() => onSave({ defaultWeightPerItemKg: defaultWeight.trim(), returnCost: returnCost.trim() })}
            loading={isSaving}
            disabled={!weightOk || !returnOk}
          >
            {p.save}
          </Button>
        </Box>
      </BlockStack>
    </Card>
  );
}

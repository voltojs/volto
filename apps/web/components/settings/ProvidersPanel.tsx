'use client';

import { useConfigStore } from '@/stores/config-store';
import { useTranslations } from 'next-intl';
import { CatalogProviderSection } from './CatalogProviderForm';
import { CustomProviderSection } from './CustomProviderForm';

/**
 * 模型配置 Tab：供应商、凭据与其下的模型清单。
 *
 * Split into two sections by provider `kind` — catalog providers pick a
 * pi-ai built-in provider and tick which of its models to enable, while
 * custom providers keep the original hand-typed form. `kind` is immutable
 * after creation (the gateway rejects changing it), so there is no control
 * anywhere in this tree that converts one into the other — switching means
 * deleting and recreating under the other section.
 */
export function ProvidersPanel() {
  const t = useTranslations('settings');
  const providers = useConfigStore((s) => s.providers);

  return (
    <div className="space-y-6">
      <p className="text-muted-foreground text-xs">
        {t('providers.secretNote')}{' '}
        <code className="font-mono">~/.volto</code>{t('providers.secretNoteTail')}
      </p>

      <CatalogProviderSection providers={providers} />
      <CustomProviderSection providers={providers} />
    </div>
  );
}

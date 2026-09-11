'use client';

import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';

export interface AvailableModelOption {
  code: string;
  name: string;
  reasoning?: boolean;
}

/**
 * Lists catalog models the current draft has not enabled yet, lets the user
 * tick any number of them, and hands the chosen codes back on confirm.
 * Empty name / token caps stay empty so each added row inherits the catalog
 * values through placeholders, same as typing a matching code by hand.
 */
export function AvailableModelsDialog({
  open,
  onOpenChange,
  options,
  selectedCodes,
  onAdd,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  options: AvailableModelOption[];
  /** Codes already present in the draft — never listed, never re-added. */
  selectedCodes: string[];
  onAdd: (codes: string[]) => void;
}) {
  const [query, setQuery] = useState('');
  const [checked, setChecked] = useState<Set<string>>(new Set());

  // A fresh open always starts from an empty selection and an empty filter —
  // leftover ticks from a previous batch would silently grow the next add.
  // Reset during render on the open transition (react.dev "adjusting state
  // when a prop changes") rather than in an effect, which would paint once
  // with stale ticks first.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setQuery('');
      setChecked(new Set());
    }
  }

  const selected = useMemo(() => new Set(selectedCodes), [selectedCodes]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return options.filter((o) => {
      if (selected.has(o.code)) return false;
      if (!q) return true;
      return (
        o.code.toLowerCase().includes(q) || o.name.toLowerCase().includes(q)
      );
    });
  }, [options, selected, query]);

  const toggle = (code: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  };

  const confirm = () => {
    // Preserve catalog order so the draft list matches the provider listing.
    const codes = options
      .map((o) => o.code)
      .filter((code) => checked.has(code) && !selected.has(code));
    if (codes.length === 0) return;
    onAdd(codes);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>获取可用模型</DialogTitle>
          <DialogDescription>
            从该 Provider 的目录中勾选尚未添加的模型。
          </DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search className="text-muted-foreground absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2" />
          <Input
            className="h-8 pl-8 text-xs"
            placeholder="搜索 code 或名称"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="搜索可用模型"
          />
        </div>

        <div className="max-h-64 space-y-0.5 overflow-y-auto">
          {visible.length === 0 && (
            <p className="text-muted-foreground py-4 text-center text-xs">
              {options.every((o) => selected.has(o.code))
                ? '目录中的模型已全部添加'
                : '没有匹配的模型'}
            </p>
          )}
          {visible.map((o) => (
            <label
              key={o.code}
              className="hover:bg-muted/50 flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5"
              onClick={(e) => {
                // Base UI's Checkbox is not a native input, so the wrapping
                // <label> does not forward the click — toggle explicitly.
                e.preventDefault();
                toggle(o.code);
              }}
            >
              <Checkbox
                checked={checked.has(o.code)}
                onCheckedChange={() => toggle(o.code)}
                aria-label={`选择 ${o.code}`}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-mono text-xs">
                  {o.code}
                </span>
                <span className="text-muted-foreground block truncate text-[11px]">
                  {o.name}
                  {o.reasoning ? ' · 推理' : ''}
                </span>
              </span>
            </label>
          ))}
        </div>

        <DialogFooter>
          <Button
            size="sm"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            取消
          </Button>
          <Button size="sm" onClick={confirm} disabled={checked.size === 0}>
            添加 {checked.size > 0 ? checked.size : ''} 个
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

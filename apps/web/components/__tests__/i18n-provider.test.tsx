import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";

// The shared setup mocks next-intl's lookup against the zh catalog; this spec
// must exercise the real provider with the real catalogs instead.
vi.unmock("next-intl");

import { useTranslations } from "next-intl";
import { I18nProvider } from "../i18n-provider";

function Probe() {
  const t = useTranslations("common");
  return <span>{t("meta.description")}</span>;
}

it("按传入 locale 渲染对应语言", () => {
  render(<I18nProvider locale="en"><Probe /></I18nProvider>);
  expect(screen.getByText(/volto/i)).toBeInTheDocument();
});
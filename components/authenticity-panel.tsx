"use client";
import { useEffect, useRef, useState } from "react";
import { countWords, languageSchema, type TextLanguage } from "@/lib/languages";
import {
  ImagePlus,
  FileText,
  ShieldAlert,
  ShieldCheck,
  Clock3,
  LoaderCircle,
  CircleHelp,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import type {
  Capability,
  JobView,
  Outcome,
  ThreatResult,
} from "@/lib/contracts";

async function responseJson<T>(response: Response): Promise<T> {
  const data: unknown = await response.json();
  if (!response.ok) {
    const message =
      data &&
      typeof data === "object" &&
      "error" in data &&
      typeof data.error === "string"
        ? data.error
        : "Проверка временно недоступна.";
    throw new Error(message);
  }
  return data as T;
}
function useJob(initial: JobView | null) {
  const [job, setJob] = useState<JobView | null>(initial),
    [error, setError] = useState("");
  useEffect(() => {
    setJob(initial);
    setError("");
  }, [initial]);
  useEffect(() => {
    if (!initial || initial.state === "finished") return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const start = Date.now();
    const poll = async () => {
      try {
        const result = (await responseJson(
          await fetch(`/api/jobs/${initial.id}`, {
            signal: controller.signal,
            cache: "no-store",
          }),
        )) as JobView;
        setJob(result);
        if (result.state !== "finished") {
          if (Date.now() - start > 240000) {
            setError(
              "Проверка занимает больше времени. Повторная отправка тех же данных вернёт текущее задание.",
            );
            return;
          }
          timer = setTimeout(poll, 2500);
        }
      } catch (error) {
        if (!controller.signal.aborted)
          setError(
            error instanceof Error
              ? error.message
              : "Не удалось получить результат.",
          );
      }
    };
    timer = setTimeout(poll, 1500);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [initial]);
  return { job, error };
}
function OutcomeView({ outcome }: { outcome: Outcome | null }) {
  if (!outcome) return null;
  if (outcome.status !== "completed")
    return (
      <div className="media-outcome uncertain">
        <CircleHelp size={20} />
        <div>
          <strong>
            {outcome.status === "inconclusive"
              ? "Недостаточно данных"
              : "Проверка не выполнена"}
          </strong>
          <p>{outcome.details}</p>
        </div>
      </div>
    );
  if (!("result" in outcome)) return null;
  return (
    <div
      className={`media-outcome ${outcome.result.isAI ? "attention" : "neutral"}`}
    >
      <div className="model-score"><span className="model-score-label">Балл модели</span>
        {outcome.result.confidence.toLocaleString("ru-RU", {
          maximumFractionDigits: 1,
        })}
        <small>%</small>
      </div>
      <div>
        <strong>
          {outcome.result.isAI
            ? "Модель нашла признаки ИИ"
            : "Выраженные признаки ИИ не найдены"}
        </strong>
        <p>{outcome.result.details}</p>
        <span className="score-caption">
          Оценка модели · не доказательство подделки
        </span>
      </div>
    </div>
  );
}
export function AuthenticityPanel({
  threat: initialThreat,
  target,
  analyzing,
  onThreatChange,
}: {
  threat?: ThreatResult;
  target: string;
  analyzing: boolean;
  onThreatChange: (threat: ThreatResult, target: string) => void;
}) {
  const [capabilities, setCapabilities] = useState<Capability[]>([]),
    [availability, setAvailability] = useState<"loading" | "ready" | "error">(
      "loading",
    );
  const [detector, setDetector] = useState<"image-ai" | "deepfake">("image-ai"),
    [file, setFile] = useState<File | null>(null),
    [text, setText] = useState(""),
    [language, setLanguage] = useState<TextLanguage>("ru");
  const [imageInitial, setImageInitial] = useState<JobView | null>(null),
    [textInitial, setTextInitial] = useState<JobView | null>(null);
  const [submitting, setSubmitting] = useState<"image" | "text" | null>(null),
    [imageError, setImageError] = useState(""),
    [textError, setTextError] = useState("");
  const image = useJob(imageInitial),
    written = useJob(textInitial),
    signature = useJob(initialThreat?.signatureJob ?? null);
  const [threat, setThreat] = useState(initialThreat),
    [refreshError, setRefreshError] = useState("");
  const uploadRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setThreat(initialThreat);
    setRefreshError("");
  }, [initialThreat]);
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/capabilities", { signal: controller.signal, cache: "no-store" })
      .then((r) => responseJson<{ capabilities: Capability[] }>(r))
      .then((data) => {
        setCapabilities(data.capabilities);
        setAvailability("ready");
      })
      .catch(() => {
        if (!controller.signal.aborted) setAvailability("error");
      });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    if (signature.job?.state !== "finished" || !target) return;
    const controller = new AbortController();
    fetch("/api/threat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: target }),
      signal: controller.signal,
    })
      .then((r) => responseJson<ThreatResult>(r))
      .then((value) => {
        setThreat(value);
        onThreatChange(value, target);
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setRefreshError(
            "Не удалось обновить статус угрозы. Переход остаётся закрыт.",
          );
      });
    return () => controller.abort();
  }, [signature.job?.state, signature.job?.id, target, onThreatChange]);
  const imageReady = capabilities.some((c) => c.detector === detector),
    textReady = capabilities.some(
      (c) => c.detector === "text-ai" && c.languages.includes(language),
    );
  const imageBusy =
    submitting === "image" ||
    (!!image.job && image.job.state !== "finished" && !image.error);
  const textBusy =
    submitting === "text" ||
    (!!written.job && written.job.state !== "finished" && !written.error);
  const state = (job: JobView | null, busy: boolean, ready: boolean) =>
    busy
      ? job?.state === "running"
        ? "Анализируем"
        : "В очереди"
      : job?.outcome?.status === "completed"
        ? "Результат готов"
        : job?.outcome
          ? "Недостаточно данных"
          : availability === "loading"
            ? "Проверяем доступность"
            : ready
              ? "Готово к проверке"
              : "Модель не подключена";
  async function submitImage() {
    if (!file || imageBusy) return;
    setImageError("");
    setImageInitial(null);
    setSubmitting("image");
    try {
      if (file.size > 2097152)
        throw new Error("Выберите PNG или JPEG размером до 2 МБ.");
      const encoded = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1]);
        reader.onerror = () => reject(new Error("Файл не удалось прочитать."));
        reader.readAsDataURL(file);
      });
      const job = await responseJson<JobView>(
        await fetch("/api/media", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ detector, imageBase64: encoded }),
          signal: AbortSignal.timeout(30000),
        }),
      );
      setImageInitial(job);
    } catch (error) {
      setImageError(
        error instanceof Error
          ? error.message
          : "Не удалось отправить изображение.",
      );
    } finally {
      setSubmitting(null);
    }
  }
  async function submitText() {
    if (textBusy) return;
    setTextError("");
    setTextInitial(null);
    setSubmitting("text");
    try {
      const job = await responseJson<JobView>(
        await fetch("/api/media", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ detector: "text-ai", text, language }),
          signal: AbortSignal.timeout(15000),
        }),
      );
      setTextInitial(job);
    } catch (error) {
      setTextError(
        error instanceof Error ? error.message : "Не удалось отправить текст.",
      );
    } finally {
      setSubmitting(null);
    }
  }
  const blocked = threat?.status === "blocked";
  return (
    <section
      className="authenticity-section"
      aria-label="Подлинность контента и угрозы"
    >
      <div className="check-indicators" aria-live="polite">
        <div className={`check-indicator ${imageBusy ? "working" : ""}`}>
          <ImagePlus size={20} />
          <span>
            <strong>Проверка медиа</strong>
            <small>{state(image.job, imageBusy, imageReady)}</small>
          </span>
          {imageBusy && <LoaderCircle className="spin" size={16} />}
        </div>
        <div className={`check-indicator ${textBusy ? "working" : ""}`}>
          <FileText size={20} />
          <span>
            <strong>Анализ текста</strong>
            <small>{state(written.job, textBusy, textReady)}</small>
          </span>
          {textBusy && <LoaderCircle className="spin" size={16} />}
        </div>
        <div
          className={`check-indicator ${blocked ? "danger" : threat?.status === "clear" ? "clear" : ""}`}
        >
          <ShieldCheck size={20} />
          <span>
            <strong>Статус угрозы</strong>
            <small>
              {analyzing
                ? "Проверяем ссылку"
                : blocked
                  ? "Переход заблокирован"
                  : threat?.status === "clear"
                    ? "Угрозы не обнаружены"
                    : threat
                      ? "Проверка неполная"
                      : "Ожидает ссылки"}
            </small>
          </span>
        </div>
      </div>
      {threat && !analyzing && (
        <div
          className={`threat-notice ${blocked ? "blocked" : threat.status}`}
          role={blocked ? "alert" : "status"}
        >
          <ShieldAlert size={22} />
          <div>
            <strong>
              {blocked
                ? "Переход заблокирован"
                : threat.status === "hold"
                  ? "Переход пока закрыт"
                  : "Проверки угроз завершены"}
            </strong>
            <p>{threat.reason}</p>
            {signature.job && signature.job.state !== "finished" && (
              <p className="job-progress">
                <LoaderCircle className="spin" size={15} />
                Антивирусная проверка{" "}
                {signature.job.state === "queued" ? "в очереди" : "выполняется"}
              </p>
            )}
            {(signature.error || refreshError) && (
              <p>{signature.error || refreshError}</p>
            )}
            {signature.job?.outcome &&
              signature.job.outcome.status !== "completed" && (
                <p>{signature.job.outcome.details}</p>
              )}
            <Accordion type="single" collapsible>
              <AccordionItem value="sources">
                <AccordionTrigger className="threat-details-trigger">
                  Причины и источники
                </AccordionTrigger>
                <AccordionContent>
                  <ul className="threat-source-list">
                    {threat.checks.map((c) => (
                      <li key={c.source}>
                        <strong>{c.source}</strong>
                        <span>{c.detail}</span>
                      </li>
                    ))}
                  </ul>
                </AccordionContent>
              </AccordionItem>
            </Accordion>
            {threat.navigationAllowed && !blocked && !refreshError && (
              <form method="post" action="/api/out">
                <input type="hidden" name="url" value={target} />
                <Button type="submit">Открыть после повторной проверки</Button>
              </form>
            )}
          </div>
        </div>
      )}
      <Accordion type="single" collapsible className="media-accordion" defaultValue="content">
        <AccordionItem value="content">
          <AccordionTrigger className="media-trigger">
            <span>
              <ImagePlus size={20} />
              Проверить фото или текст
            </span>
            <span className="optional-tag">Подлинность контента</span>
          </AccordionTrigger>
          <AccordionContent>
            <div className="media-workspace">
              <p className="media-intro">
                Загрузите само изображение или вставьте текст публикации.
                Закрытые профили и содержимое соцсетей автоматически не
                извлекаются.
              </p>
              {availability === "error" && (
                <p role="alert" className="form-error">
                  Не удалось узнать доступность моделей. Обновите страницу
                  позже.
                </p>
              )}
              <Tabs defaultValue="image">
                <TabsList>
                  <TabsTrigger value="image">Изображение</TabsTrigger>
                  <TabsTrigger value="text">Текст</TabsTrigger>
                </TabsList>
                <TabsContent value="image">
                  <label className="input-label" htmlFor="media-detector">
                    Что проверить
                  </label>
                  <select
                    id="media-detector"
                    value={detector}
                    disabled={imageBusy}
                    onChange={(e) => {
                      setDetector(e.target.value as typeof detector);
                      setImageInitial(null);
                      setImageError("");
                    }}
                  >
                    <option value="image-ai">Генерация изображения ИИ</option>
                    <option value="deepfake">Подмена лица · портрет</option>
                  </select>
                  <div className="upload-area">
                    <ImagePlus size={30} />
                    <div>
                      <strong>
                        {file ? file.name : "PNG или JPEG, до 2 МБ"}
                      </strong>
                      <p>
                        {file
                          ? `${(file.size / 1024).toFixed(0)} КБ`
                          : "Лицо крупным планом для проверки deepfake"}
                      </p>
                    </div>
                    <input
                      ref={uploadRef}
                      type="file"
                      id="media-file"
                      accept="image/png,image/jpeg"
                      disabled={imageBusy}
                      onChange={(e) => {
                        setFile(e.target.files?.[0] ?? null);
                        setImageInitial(null);
                        setImageError("");
                      }}
                      aria-label="Выбрать изображение"
                    />
                  </div>
                  {!imageReady && availability !== "loading" && (
                    <p className="module-unavailable">
                      Модель изображений сейчас не подключена. Файл не будет
                      отправлен, процент не рассчитывается.
                    </p>
                  )}
                  <Button
                    onClick={() => void submitImage()}
                    disabled={
                      !imageReady || !file || imageBusy || submitting !== null
                    }
                  >
                    {imageBusy ? (
                      <>
                        <LoaderCircle className="spin" />
                        Проверяем изображение
                      </>
                    ) : (
                      "Проверить изображение"
                    )}
                  </Button>
                  {(imageError || image.error) && (
                    <p className="form-error" role="alert">
                      {imageError || image.error}
                    </p>
                  )}
                  <OutcomeView outcome={image.job?.outcome ?? null} />
                </TabsContent>
                <TabsContent value="text">
                  <div className="text-input-heading">
                    <label className="input-label" htmlFor="media-text">
                      Текст публикации
                    </label>
                    <select
                      aria-label="Язык текста"
                      value={language}
                      disabled={textBusy}
                      onChange={(e) => {
                        setLanguage(languageSchema.parse(e.target.value));
                        setTextInitial(null);
                      }}
                    >
                      {[...new Set<TextLanguage>(["ru", "en", ...capabilities.filter(c => c.detector === "text-ai").flatMap(c => c.languages)])].map(code => (
                        <option key={code} value={code}>
                          {code === "ru" ? "Русский" : code === "en" ? "English" : new Intl.DisplayNames(["ru"], { type: "language" }).of(code)}
                        </option>
                      ))}
                    </select>
                  </div>
                  <Textarea
                    id="media-text"
                    value={text}
                    maxLength={12000}
                    disabled={textBusy}
                    onChange={(e) => {
                      setText(e.target.value);
                      setTextInitial(null);
                      setTextError("");
                    }}
                    placeholder="Вставьте связный текст: от 80 слов и 400 символов"
                    rows={6}
                  />
                  <p className="text-count">
                    {countWords(text, language)} слов ·{" "}
                    {text.length} / 12 000 символов
                  </p>
                  <p className="text-count">Оцениваем признаки генерации ИИ. Достоверность фактов этой проверкой не устанавливается.</p>
                  {!textReady && availability !== "loading" && (
                    <p className="module-unavailable">
                      Для выбранного языка сейчас нет подключённой модели.
                      Процент не рассчитывается.
                    </p>
                  )}
                  <Button
                    onClick={() => void submitText()}
                    disabled={
                      !textReady ||
                      !text.trim() ||
                      textBusy ||
                      submitting !== null
                    }
                  >
                    {textBusy ? (
                      <>
                        <LoaderCircle className="spin" />
                        Анализируем текст
                      </>
                    ) : (
                      "Проверить текст"
                    )}
                  </Button>
                  {(textError || written.error) && (
                    <p className="form-error" role="alert">
                      {textError || written.error}
                    </p>
                  )}
                  <OutcomeView outcome={written.job?.outcome ?? null} />
                </TabsContent>
              </Tabs>
              <p className="media-privacy">
                <Clock3 size={15} />
                Исходные данные удаляются после обработки. Доступ к результату —
                только в вашей сессии, до 24 часов.
              </p>
            </div>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </section>
  );
}

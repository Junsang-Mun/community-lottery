<script lang="ts">
  import { onMount } from "svelte";
  import type {
    Applicant,
    ApplicantRaw,
    AuditEvent,
    AuditSummary,
    LotteryConfig,
    RandomnessMetric,
    RoundingMode,
    ZipDongRecord,
  } from "$lib/types";
  import {
    parseExcelApplicants,
    sha256HexOfArrayBuffer,
  } from "$lib/parsers/excel";
  import { parseZipMappingText } from "$lib/parsers/zipMapping";
  import { detectCollisions } from "$lib/lottery/dedupe";
  import { anonIdOf } from "$lib/privacy/anon";
  import { buildApplicant } from "$lib/lottery/classify";
  import { fetchPublicRandomness } from "$lib/randomness/providers";
  import { runLottery } from "$lib/lottery/draw";
  import { appendAuditEntry, toJsonLines } from "$lib/audit/hashChain";
  import {
    buildAuditIntegrityManifest,
    signAuditIntegrityManifest,
    verifyAuditIntegrityBundle,
  } from "$lib/audit/integrity";
  import {
    buildAuditPackageZip,
    buildIndividualCertificatePdf,
  } from "$lib/export/files";
  import { triggerDownload } from "$lib/export/download";
  import { maskedPublicRow } from "$lib/privacy/mask";
  import {
    verifyAuditAndReplay,
    parseAuditJsonl,
    verifyIndividualResult,
    type IndividualResult,
    type VerifyAuditReplayResult,
  } from "$lib/verify/replay";

  type Tab = "admin" | "public" | "verify";

  let tab: Tab = "admin";
  let dongs: string[] = [];
  let selectedDong = "";
  let capacity = 20;
  let roundingMode: RoundingMode = "floor";
  let tolerancePercent = 1;
  let proxyBase = "";
  let lectureName = "";

  let excelName = "";
  let excelHash = "";
  let rawRows: ApplicantRaw[] = [];

  let zipMap: Map<string, ZipDongRecord> | null = null;
  let zipMapCount = 0;

  let collisions = new Map<string, ApplicantRaw[]>();
  let duplicateSelections = new Map<string, number[]>();
  let duplicateModalOpen = false;
  let dedupeImpactAnonIds: string[] = [];

  let applicants: Applicant[] = [];
  let validApplicants: Applicant[] = [];
  let invalidApplicants: Applicant[] = [];

  let btcMetric: RandomnessMetric | null = null;
  let nistMetric: RandomnessMetric | null = null;
  let manualBTC = "";
  let manualNIST = "";
  let operatorConfirmedDisagreement = false;

  let auditChain: AuditEvent[] = [];
  let auditSummary: AuditSummary | null = null;
  let auditJsonl = "";

  let drawResult: {
    winners: Applicant[];
    waitlist: Applicant[];
    seedHash: string;
    runId: string;
    runSaltHex: string;
    guaranteeQuota: number;
    step1: string[];
    step2: string[];
    ordering: string[];
  } | null = null;

  let verifySummaryText = "";
  let verifyJsonlText = "";
  let verifyIntegrityManifestText = "";
  let verifyIntegritySigText = "";
  let verifyIntegrityPubText = "";
  let verifySummary: AuditSummary | null = null;
  let verifyEvents: AuditEvent[] | null = null;
  let verifyResult: VerifyAuditReplayResult | null = null;
  let integrityCheck: {
    hashOk: boolean;
    signatureOk: boolean;
    reasons: string[];
  } | null = null;

  // Individual Verification GUI
  let individualQuery = "";
  let individualResult: IndividualResult | null = null;

  let busy = false;
  let message = "";
  let zipHelpOpen = false;
  let invalidBannerDismissed = false;
  let lastInvalidCount = 0;

  function sanitizeFilenameBase(text: string): string {
    return text
      .trim()
      .replace(/[\\/:*?"<>|]/g, "_")
      .replace(/\s+/g, "_");
  }

  function toggleZipHelp() {
    zipHelpOpen = !zipHelpOpen;
  }

  function closeZipHelp() {
    zipHelpOpen = false;
  }

  $: {
    const currentInvalidCount = invalidApplicants.length;
    if (currentInvalidCount === 0) {
      invalidBannerDismissed = false;
    } else if (currentInvalidCount !== lastInvalidCount) {
      invalidBannerDismissed = false;
    }
    lastInvalidCount = currentInvalidCount;
  }

  function registrationEpoch(v: string | undefined): number {
    const t = Date.parse((v ?? "").trim());
    return Number.isFinite(t) ? t : 0;
  }

  function unresolvedDuplicateKeys(): string[] {
    return [...collisions.keys()].filter(
      (k) => (duplicateSelections.get(k)?.length ?? 0) === 0,
    );
  }

  function unresolvedDuplicateCount(): number {
    return unresolvedDuplicateKeys().length;
  }

  function toggleDuplicateSelection(key: string, rowIndex: number) {
    const next = new Map(duplicateSelections);
    const prev = next.get(key) ?? [];
    if (prev.includes(rowIndex)) {
      next.set(
        key,
        prev.filter((v) => v !== rowIndex),
      );
    } else {
      next.set(key, [...prev, rowIndex]);
    }
    duplicateSelections = next;
    rebuildApplicants();
  }

  function resolveAllDuplicates(mode: "latest" | "earliest") {
    const next = new Map(duplicateSelections);
    for (const [key, list] of collisions.entries()) {
      const sorted = [...list].sort(
        (a, b) => registrationEpoch(a.등록일) - registrationEpoch(b.등록일),
      );
      const target = mode === "latest" ? sorted[sorted.length - 1] : sorted[0];
      next.set(key, [target.rowIndex]);
    }
    duplicateSelections = next;
    rebuildApplicants();
  }

  onMount(async () => {
    const res = await fetch("/dongs.incheon-seogu.json");
    dongs = await res.json();
    selectedDong = dongs[0] ?? "아라1동";
  });

  async function handleDongOverrideUpload(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    const text = await file.text();
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed) || parsed.some((v) => typeof v !== "string")) {
      message = "동 목록 JSON 형식이 올바르지 않습니다.";
      return;
    }
    dongs = parsed;
    selectedDong = dongs[0] ?? selectedDong;
    message = `동 목록 ${dongs.length}개로 교체됨`;
  }

  async function handleZipUpload(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    const text = await file.text();
    zipMap = parseZipMappingText(text);
    zipMapCount = zipMap.size;
    await rebuildApplicants();
  }

  async function handleExcelUpload(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    excelName = file.name;
    const bytes = await file.arrayBuffer();
    excelHash = await sha256HexOfArrayBuffer(bytes);
    rawRows = parseExcelApplicants(bytes).rows;
    collisions = detectCollisions(rawRows);
    duplicateSelections = new Map();
    duplicateModalOpen = collisions.size > 0;
    if (collisions.size > 0) {
      message = `중복 의심 ${collisions.size}건 발견: 수동 처리 후 추첨 가능합니다.`;
    }
    await rebuildApplicants();
  }

  async function rebuildApplicants() {
    if (!rawRows.length || !excelHash) {
      applicants = [];
      validApplicants = [];
      invalidApplicants = [];
      return;
    }

    const allAnon = await Promise.all(
      rawRows.map((row) => anonIdOf(excelHash, row)),
    );
    const collisionRowIndexes = new Set<number>();
    for (const list of collisions.values()) {
      for (const row of list) collisionRowIndexes.add(row.rowIndex);
    }

    const keptRows = rawRows.filter(
      (r) => !collisionRowIndexes.has(r.rowIndex),
    );
    for (const [key, list] of collisions.entries()) {
      const selectedRowIndexes = duplicateSelections.get(key) ?? [];
      if (!selectedRowIndexes.length) continue;
      const selectedSet = new Set(selectedRowIndexes);
      for (const row of list) {
        if (selectedSet.has(row.rowIndex)) keptRows.push(row);
      }
    }
    keptRows.sort((a, b) => a.rowIndex - b.rowIndex);

    const keptSet = new Set(keptRows.map((r) => r.rowIndex));
    dedupeImpactAnonIds = allAnon.filter(
      (_, idx) => !keptSet.has(rawRows[idx].rowIndex),
    );

    const built: Applicant[] = [];
    for (const row of keptRows) {
      const anonId = await anonIdOf(excelHash, row);
      built.push(buildApplicant(row, anonId, selectedDong, zipMap));
    }
    applicants = built;
    validApplicants = built.filter((a) => a.valid);
    invalidApplicants = built.filter((a) => !a.valid);
  }

  function hasDisagreementWarning(): boolean {
    return Boolean(btcMetric?.warning || nistMetric?.warning);
  }

  function finalBtcValue(): string {
    return manualBTC.trim() || btcMetric?.finalValue || "";
  }

  function finalNistValue(): string {
    return manualNIST.trim() || nistMetric?.finalValue || "";
  }

  async function fetchRandomness() {
    busy = true;
    message = "난수 씨드 조회 중...";
    try {
      const out = await fetchPublicRandomness(
        tolerancePercent,
        proxyBase.trim() || undefined,
      );
      btcMetric = out.btc;
      nistMetric = out.nist;
      const nistOk = out.nist.samples.filter((s) => s.ok).length;
      if (nistOk === 0 && !proxyBase.trim()) {
        message =
          "조회 완료 (NIST 실패: Edge Proxy URL 설정 권장 또는 수동값 입력)";
      } else {
        message = "조회 완료";
      }
    } catch (error) {
      message = `조회 실패: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      busy = false;
    }
  }

  function randomHex(bytesLen: number): string {
    const b = new Uint8Array(bytesLen);
    crypto.getRandomValues(b);
    return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  }

  async function runDraw() {
    if (capacity <= 0) {
      message = "정원은 1 이상이어야 합니다.";
      return;
    }
    if (!selectedDong) {
      message = "행정동을 선택하세요.";
      return;
    }
    if (!excelHash || !applicants.length) {
      message = "엑셀 파일을 먼저 업로드하세요.";
      return;
    }
    if (invalidApplicants.length > 0) {
      const preview = invalidApplicants
        .slice(0, 3)
        .map(
          (a) =>
            `행#${a.rowIndex}: ${a.invalidReasons.join(", ") || "필수값 누락"}`,
        )
        .join(" / ");
      message = `필수 항목 누락 행 ${invalidApplicants.length}건이 있어 추첨할 수 없습니다. ${preview}`;
      return;
    }
    if (unresolvedDuplicateCount() > 0) {
      duplicateModalOpen = true;
      message = `중복 의심 ${unresolvedDuplicateCount()}건을 먼저 처리하세요.`;
      return;
    }

    const btcValue = finalBtcValue();
    const nistValue = finalNistValue();
    if (!btcValue || !nistValue) {
      message = "BTC/NIST 값을 확보하거나 수동 입력하세요.";
      return;
    }
    if (hasDisagreementWarning() && !operatorConfirmedDisagreement) {
      message =
        "프로바이더 편차 경고를 확인하고 운영자 확인 체크가 필요합니다.";
      return;
    }

    busy = true;
    message = "추첨 중...";

    try {
      const runId = crypto.randomUUID();
      const runSaltHex = randomHex(32);
      const cfg: LotteryConfig = {
        selectedDong,
        capacity,
        roundingMode,
      };

      auditChain = [];
      await appendAuditEntry(auditChain, "run_started", {
        run_id: runId,
        excel_hash: excelHash,
        selected_dong: selectedDong,
        capacity,
        rounding_mode: roundingMode,
        duplicate_resolution_mode: "manual-per-person",
        duplicate_collision_count: collisions.size,
      });

      await appendAuditEntry(auditChain, "validation_summary", {
        uploaded_rows: rawRows.length,
        kept_rows_after_dedupe: applicants.length,
        valid_rows: validApplicants.length,
        invalid_rows: invalidApplicants.length,
        dedupe_impact_anon_ids: dedupeImpactAnonIds,
      });

      if (invalidApplicants.length) {
        await appendAuditEntry(auditChain, "invalid_rows", {
          items: invalidApplicants.map((a) => ({
            anon_id: a.anonId,
            member_id: (a.회원ID ?? "").trim(),
            reasons: a.invalidReasons,
          })),
        });
      }

      await appendAuditEntry(auditChain, "classification_summary", {
        selected_dong: selectedDong,
        target_group: validApplicants.filter((a) => a.selectedDongMatch).length,
        other_group: validApplicants.filter((a) => !a.selectedDongMatch).length,
        items: validApplicants.map((a) => ({
          anon_id: a.anonId,
          member_id: (a.회원ID ?? "").trim(),
          selected_dong_match: a.selectedDongMatch,
          source: a.classificationSource,
          reason: a.classificationReason,
        })),
      });

      await appendAuditEntry(auditChain, "randomness_inputs", {
        btc_final_value: btcValue,
        nist_final_value: nistValue,
        btc_manual_override: Boolean(manualBTC.trim()),
        nist_manual_override: Boolean(manualNIST.trim()),
        provider_samples: {
          btc: btcMetric?.samples ?? [],
          nist: nistMetric?.samples ?? [],
        },
      });

      if (hasDisagreementWarning()) {
        await appendAuditEntry(auditChain, "operator_confirmation", {
          confirmed: operatorConfirmedDisagreement,
          warning_btc: btcMetric?.warning ?? "",
          warning_nist: nistMetric?.warning ?? "",
        });
      }

      const draw = await runLottery(validApplicants, cfg, {
        excelHash,
        config: cfg,
        finalBTCValueUsed: btcValue,
        finalNISTValueUsed: nistValue,
        runId,
        runSaltHex,
      });

      drawResult = {
        winners: draw.winners,
        waitlist: draw.waitlist,
        seedHash: draw.seedHash,
        runId,
        runSaltHex,
        guaranteeQuota: draw.guaranteeQuota,
        step1: draw.step1WinnerAnonIds,
        step2: draw.step2WinnerAnonIds,
        ordering: draw.ordering,
      };

      await appendAuditEntry(auditChain, "draw_completed", {
        seed_hash: draw.seedHash,
        guarantee_quota: draw.guaranteeQuota,
        winners: draw.winners.map((w) => w.anonId),
        winners_member_ids: draw.winners.map((w) => (w.회원ID ?? "").trim()),
        waitlist: draw.waitlist.map((w) => w.anonId),
        waitlist_member_ids: draw.waitlist.map((w) => (w.회원ID ?? "").trim()),
        ordering: draw.ordering,
      });

      auditJsonl = toJsonLines(auditChain);
      const finalHash = auditChain.length
        ? auditChain[auditChain.length - 1].entry_hash
        : "GENESIS";
      const applicantsForReplay = applicants.map((a) => ({
        anonId: a.anonId,
        memberId: (a.회원ID ?? "").trim(),
        valid: a.valid,
        selectedDongMatch: a.selectedDongMatch,
        invalidReasons: a.invalidReasons,
        classificationReason: a.classificationReason,
      }));

      auditSummary = {
        appVersion: "1.0.1",
        excelHash,
        runId,
        runSaltHex,
        seedHash: draw.seedHash,
        finalHash,
        generatedAt: new Date().toISOString(),
        config: {
          selectedDong,
          capacity,
          roundingMode,
          guaranteeQuota: draw.guaranteeQuota,
        },
        randomness: {
          btc: {
            metric: "BTC",
            finalValue: btcValue,
            samples: btcMetric?.samples ?? [],
            warning: btcMetric?.warning,
            manualOverride: Boolean(manualBTC.trim()),
          },
          nist: {
            metric: "NIST",
            finalValue: nistValue,
            samples: nistMetric?.samples ?? [],
            warning: nistMetric?.warning,
            manualOverride: Boolean(manualNIST.trim()),
          },
        },
        totals: {
          uploadedRows: rawRows.length,
          validApplicants: validApplicants.length,
          invalidApplicants: invalidApplicants.length,
          winners: draw.winners.length,
          waitlist: draw.waitlist.length,
        },
        applicantsForReplay,
        drawOutput: {
          winners: draw.winners.map((w) => w.anonId),
          waitlist: draw.waitlist.map((w) => w.anonId),
          step1: draw.step1WinnerAnonIds,
          step2: draw.step2WinnerAnonIds,
          ordering: draw.ordering,
        },
      };

      message = "추첨 완료";
    } catch (error) {
      message = `추첨 실패: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      busy = false;
    }
  }

  async function exportZip() {
    if (!drawResult || !auditSummary) {
      message = "먼저 추첨을 실행하세요.";
      return;
    }
    try {
      const safeLectureName = sanitizeFilenameBase(lectureName);
      const auditSummaryText = JSON.stringify(auditSummary, null, 2);
      const integrityManifest = await buildAuditIntegrityManifest(
        auditJsonl,
        auditSummaryText,
      );
      const signed = await signAuditIntegrityManifest(integrityManifest);
      const zip = await buildAuditPackageZip({
        winners: drawResult.winners,
        waitlist: drawResult.waitlist,
        auditJsonl,
        auditSummary,
        filenameBase: safeLectureName || undefined,
        integrityManifestJson: JSON.stringify(integrityManifest, null, 2),
        integritySignatureBase64: signed.signatureBase64,
        integrityPublicKeyJson: JSON.stringify(signed.publicJwk, null, 2),
      });
      const zipName = safeLectureName
        ? `${safeLectureName}_audit_package.zip`
        : "audit_package.zip";
      triggerDownload(zip, zipName, "application/zip");
      message = "결과 보고서 생성 완료";
    } catch (error) {
      message = `내보내기 실패: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  async function verifyAudit() {
    try {
      verifySummary = JSON.parse(verifySummaryText) as AuditSummary;
      verifyEvents = parseAuditJsonl(verifyJsonlText);
      verifyResult = await verifyAuditAndReplay(verifySummary, verifyEvents);
      integrityCheck = null;
      if (
        verifyIntegrityManifestText.trim() &&
        verifyIntegritySigText.trim() &&
        verifyIntegrityPubText.trim()
      ) {
        integrityCheck = await verifyAuditIntegrityBundle({
          manifestText: verifyIntegrityManifestText,
          signatureBase64: verifyIntegritySigText,
          publicKeyText: verifyIntegrityPubText,
          auditJsonlText: verifyJsonlText,
          auditSummaryText: verifySummaryText,
        });
      }
      individualResult = null;
    } catch (err: any) {
      alert("검증 중 오류: " + err.message);
    }
  }

  async function lookupIndividual() {
    if (!verifySummary || !verifyResult) return;
    if (!individualQuery.trim()) return;

    individualResult = verifyIndividualResult(
      individualQuery,
      verifyResult.replayResult,
    );

    // Only download PDF if they are legally in the pool
    if (
      individualResult.status !== "NOT_FOUND" &&
      individualResult.applicant &&
      verifySummary
    ) {
      try {
        const pdfBytes = await buildIndividualCertificatePdf(
          individualResult.applicant,
          {
            status: individualResult.status,
            waitlistRank: individualResult.waitlistRank,
          },
          verifySummary,
        );
        const pdfArrayBuffer = new ArrayBuffer(pdfBytes.byteLength);
        new Uint8Array(pdfArrayBuffer).set(pdfBytes);
        const blob = new Blob([pdfArrayBuffer], { type: "application/pdf" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `개인추첨결과인증서_${individualResult.applicant.anonId}.pdf`;
        a.click();
        URL.revokeObjectURL(url);
      } catch (err: any) {
        alert("개인 인증서 생성 실패: " + err.message);
      }
    }
  }

  async function handleVerifySummaryUpload(event: Event) {
    const file = (event.currentTarget as HTMLInputElement).files?.[0];
    if (!file) return;
    verifySummaryText = await file.text();
  }

  async function handleVerifyJsonlUpload(event: Event) {
    const file = (event.currentTarget as HTMLInputElement).files?.[0];
    if (!file) return;
    verifyJsonlText = await file.text();
  }

  async function handleVerifyIntegrityManifestUpload(event: Event) {
    const file = (event.currentTarget as HTMLInputElement).files?.[0];
    if (!file) return;
    verifyIntegrityManifestText = await file.text();
  }

  async function handleVerifyIntegritySigUpload(event: Event) {
    const file = (event.currentTarget as HTMLInputElement).files?.[0];
    if (!file) return;
    verifyIntegritySigText = await file.text();
  }

  async function handleVerifyIntegrityPubUpload(event: Event) {
    const file = (event.currentTarget as HTMLInputElement).files?.[0];
    if (!file) return;
    verifyIntegrityPubText = await file.text();
  }
</script>

<svelte:window on:click={closeZipHelp} />

<div class="container animate-fade-in">
  <div class="card" style="margin-bottom: 24px; text-align: center;">
    <h1
      style="background: linear-gradient(135deg, #fff 0%, #a5b4fc 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent;"
    >
      주민자치 프로그램 참가자 추첨기
    </h1>

    <div class="tabs" style="margin: 24px auto 16px;">
      <button class:active={tab === "admin"} on:click={() => (tab = "admin")}>
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          style="margin-right: 6px;"
          ><rect width="18" height="18" x="3" y="3" rx="2" ry="2" /><line
            x1="3"
            x2="21"
            y1="9"
            y2="9"
          /><line x1="9" x2="9" y1="21" y2="9" /></svg
        >
        설정
      </button>
      <button class:active={tab === "public"} on:click={() => (tab = "public")}>
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          style="margin-right: 6px;"
          ><path d="M2 12h4l2-9 5 18 3-10 4 3 2-2" /></svg
        >
        대시보드
      </button>
      <button class:active={tab === "verify"} on:click={() => (tab = "verify")}>
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          style="margin-right: 6px;"
          ><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><polyline
            points="9 12 11 14 15 10"
          /></svg
        >
        검증
      </button>
    </div>

    {#if message}
      <div
        class="alert {message.includes('실패') || message.includes('경고')
          ? 'warn'
          : 'ok'}"
        style="margin-top: 12px; justify-content: center; max-width: 600px; margin-left: auto; margin-right: auto;"
      >
        <span style="font-weight: 600;">{message}</span>
      </div>
    {/if}
  </div>

  {#if tab === "admin"}
    <div class="grid animate-fade-in">
      <div class="card grid">
        <h2 style="display: flex; align-items: center; gap: 8px;">
          <span
            style="background: var(--accent); color: white; width: 28px; height: 28px; display: inline-flex; align-items: center; justify-content: center; border-radius: 50%; font-size: 14px;"
            >1</span
          >
          입력 업로드
        </h2>
        <label style="max-width: 100%; overflow: visible;">
          수강생 엑셀(.xlsx)
          <input
            type="file"
            accept=".xlsx"
            style="max-width: 100%; text-overflow: ellipsis; overflow: hidden; white-space: nowrap;"
            on:change={handleExcelUpload}
          />
        </label>
        <label style="max-width: 100%;">
          강좌명 (감사 보고서 파일명)
          <input
            type="text"
            bind:value={lectureName}
            placeholder="예: 2026_1분기_요가_초급"
            style="max-width: 100%;"
          />
        </label>
        <label style="max-width: 100%;">
          <span style="display: inline-flex; align-items: center; gap: 8px;">
            <span>우편번호 매핑</span>
            <button
              type="button"
              class="help-tooltip"
              class:open={zipHelpOpen}
              aria-label="우편번호 DB 안내"
              on:click|stopPropagation={toggleZipHelp}
            >
              ⓘ
              <span class="help-tooltip__bubble">
                우정사업본부 홈페이지에서 <b><u>지역별 주소 DB</u></b>를
                다운로드 받아서 업로드해 주세요.
                <a
                  href="https://www.epost.go.kr/search/areacd/zipcode_DB.zip"
                  target="_blank"
                  rel="noopener noreferrer">바로 다운로드</a
                >
              </span>
            </button>
          </span>
          <input
            type="file"
            accept=".txt,.csv"
            style="max-width: 100%; text-overflow: ellipsis; overflow: hidden; white-space: nowrap;"
            on:change={handleZipUpload}
          />
        </label>
        <label style="max-width: 100%;">
          동 목록 JSON 덮어쓰기 (선택)
          <input
            type="file"
            accept=".json"
            style="max-width: 100%; text-overflow: ellipsis; overflow: hidden; white-space: nowrap;"
            on:change={handleDongOverrideUpload}
          />
        </label>
        <div
          class="kv"
          style="margin-top: 8px; padding: 12px; background: rgba(0,0,0,0.2); border-radius: 12px; grid-template-columns: auto 1fr; align-items: start;"
        >
          <span class="small" style="white-space: nowrap; padding-right: 12px;"
            >엑셀 파일</span
          >
          <b style="word-break: break-all;">{excelName || "-"}</b>

          <span class="small" style="white-space: nowrap; padding-right: 12px;"
            >엑셀 SHA-256</span
          >
          <b style="word-break: break-all;"
            >{excelHash.slice(0, 16)}{excelHash ? "..." : "-"}</b
          >

          <span class="small" style="white-space: nowrap; padding-right: 12px;"
            >매핑/충돌</span
          >
          <b>{zipMapCount}건 / {collisions.size}건</b>
        </div>
      </div>

      <div class="card grid">
        <h2 style="display: flex; align-items: center; gap: 8px;">
          <span
            style="background: var(--accent); color: white; width: 28px; height: 28px; display: inline-flex; align-items: center; justify-content: center; border-radius: 50%; font-size: 14px;"
            >2</span
          >
          설정 및 정책
        </h2>
        <label>
          행정동 선택 (인천광역시 서구)
          <select bind:value={selectedDong} on:change={rebuildApplicants}>
            {#each dongs as dong}
              <option value={dong}>{dong}</option>
            {/each}
          </select>
        </label>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
          <label>
            정원(N)
            <input type="number" min="1" bind:value={capacity} />
          </label>
          <label>
            50% 처리
            <select bind:value={roundingMode}>
              <option value="floor">내림</option>
              <option value="ceil">올림</option>
              <option value="round">반올림</option>
            </select>
          </label>
        </div>
        {#if collisions.size > 0}
          <div class="alert warn">
            중복 의심 {collisions.size}건이 발견되었습니다. 추첨 전 개인별로
            처리 대상을 선택하세요.
            <div
              style="margin-top: 8px; display: flex; gap: 8px; flex-wrap: wrap;"
            >
              <button
                class="secondary"
                type="button"
                on:click={() => (duplicateModalOpen = true)}
              >
                중복 처리 팝업 열기
              </button>
              <button
                class="secondary"
                type="button"
                on:click={() => resolveAllDuplicates("latest")}
              >
                전체 최신 1건 선택
              </button>
              <button
                class="secondary"
                type="button"
                on:click={() => resolveAllDuplicates("earliest")}
              >
                전체 최초 1건 선택
              </button>
              <span class="badge {unresolvedDuplicateCount() ? 'warn' : 'ok'}">
                미처리 {unresolvedDuplicateCount()}건
              </span>
            </div>
          </div>
        {/if}
      </div>

      <div
        class="card grid"
        style="grid-column: 1 / -1; display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 24px;"
      >
        <div class="grid">
          <h2 style="display: flex; align-items: center; gap: 8px;">
            <span
              style="background: var(--accent); color: white; width: 28px; height: 28px; display: inline-flex; align-items: center; justify-content: center; border-radius: 50%; font-size: 14px;"
              >3</span
            >
            공개 난수 시드 가져오기
          </h2>
          <div
            style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;"
          >
            <label>
              편차 경고 임계(%)
              <input
                type="number"
                min="0"
                step="0.1"
                bind:value={tolerancePercent}
              />
            </label>
            <label>
              Edge Proxy URL
              <input
                placeholder="https://...workers.dev"
                bind:value={proxyBase}
              />
            </label>
          </div>

          <button
            class="primary"
            on:click={fetchRandomness}
            disabled={busy}
            style="padding: 16px; font-size: 1.1rem; margin-top: 8px;"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              ><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" /></svg
            >
            시드값 조회
          </button>

          {#if btcMetric || nistMetric}
            <div
              style="background: rgba(0,0,0,0.2); border-radius: 12px; padding: 16px; display: grid; gap: 12px; margin-top: 8px;"
            >
              {#if btcMetric}
                <div
                  style="display: flex; justify-content: space-between; align-items: center;"
                >
                  <span class="small">BTC Final</span>
                  <div style="display: flex; align-items: center; gap: 8px;">
                    <b style="font-size: 1.1rem;"
                      >{btcMetric.finalValue || "(미확정)"}</b
                    >
                    {#if btcMetric.warning}<span class="badge warn"
                        >{btcMetric.warning}</span
                      >{/if}
                  </div>
                </div>
              {/if}
              {#if btcMetric && nistMetric}<hr
                  style="border: 0; border-top: 1px solid rgba(255,255,255,0.1); margin: 0;"
                />{/if}
              {#if nistMetric}
                <div
                  style="display: flex; justify-content: space-between; align-items: flex-start; gap: 12px;"
                >
                  <span class="small" style="white-space: nowrap;"
                    >NIST Final</span
                  >
                  <div
                    style="display: flex; flex-direction: column; align-items: flex-end; gap: 8px;"
                  >
                    <b
                      style="font-size: 1.1rem; word-break: break-all; text-align: right;"
                      >{nistMetric.finalValue || "(미확정)"}</b
                    >
                    {#if nistMetric.warning}<span class="badge warn"
                        >{nistMetric.warning}</span
                      >{/if}
                  </div>
                </div>
              {/if}
            </div>
          {/if}
        </div>

        <div class="grid">
          <h2>수동 난수 입력 (장애 시)</h2>
          <label>
            BTC 수동 입력
            <input placeholder="예: 104321.12" bind:value={manualBTC} />
          </label>
          <label>
            NIST 수동 입력
            <input placeholder="예: 18234.56" bind:value={manualNIST} />
          </label>
          {#if hasDisagreementWarning()}
            <label
              class="alert warn"
              style="margin-top: 16px; cursor: pointer;"
            >
              <div style="display: flex; align-items: center; gap: 8px;">
                <input
                  type="checkbox"
                  bind:checked={operatorConfirmedDisagreement}
                  style="width: 20px; height: 20px;"
                />
                <span>편차 경고를 확인했고, 진행합니다</span>
              </div>
            </label>
          {/if}
        </div>
      </div>

      <div class="card grid" style="grid-column: 1 / -1;">
        <h2 style="display: flex; align-items: center; gap: 8px;">
          <span
            style="background: var(--accent); color: white; width: 28px; height: 28px; display: inline-flex; align-items: center; justify-content: center; border-radius: 50%; font-size: 14px;"
            >4</span
          >
          검증 및 추첨 실행
        </h2>

        <div
          style="display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 12px;"
        >
          <div class="badge" style="background: rgba(255,255,255,0.1);">
            전체 {rawRows.length}명
          </div>
          <div class="badge ok">유효 {validApplicants.length}명</div>
          {#if invalidApplicants.length > 0}
            <div class="badge danger">무효 {invalidApplicants.length}명</div>
          {/if}
          <div class="badge" style="background: rgba(255,255,255,0.1);">
            대상동 {validApplicants.filter((a) => a.selectedDongMatch).length}명
          </div>
          <div class="badge" style="background: rgba(255,255,255,0.1);">
            타동 {validApplicants.filter((a) => !a.selectedDongMatch).length}명
          </div>
        </div>

        <div style="display: flex; gap: 16px; margin-top: 8px;">
          <button
            class="primary"
            on:click={runDraw}
            disabled={busy ||
              invalidApplicants.length > 0 ||
              unresolvedDuplicateCount() > 0}
            style="flex: 1; padding: 18px; font-size: 1.1rem;"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"><path d="M5 12l5 5L20 7" /></svg
            >
            추첨 실행
          </button>
          <button
            class="secondary"
            on:click={exportZip}
            disabled={!drawResult}
            style="flex: 1; padding: 18px; font-size: 1.1rem;"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              ><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline
                points="7 10 12 15 17 10"
              /><line x1="12" x2="12" y1="15" y2="3" /></svg
            >
            결과 보고서 내보내기
          </button>
        </div>
      </div>
    </div>

    {#if collisions.size}
      <div class="card animate-fade-in" style="margin-top: 24px;">
        <h3 style="color: #fca5a5;">⚠️ 중복 충돌 목록</h3>
        <ul class="list small" style="padding: 6px 0;">
          {#each [...collisions.entries()] as [key, list]}
            <li style="padding: 14px 16px;">
              <span>회원 ID: {key.slice(0, 10)}...</span>
              <span
                class="badge {(duplicateSelections.get(key)?.length ?? 0) > 0
                  ? 'ok'
                  : 'warn'}"
                >{list.length}건 / {(duplicateSelections.get(key)?.length ??
                  0) > 0
                  ? `${duplicateSelections.get(key)?.length}건 선택`
                  : "미처리"}</span
              >
            </li>
          {/each}
        </ul>
      </div>
    {/if}

    {#if duplicateModalOpen}
      <div
        style="position: fixed; inset: 0; z-index: 2000; background: rgba(0,0,0,0.55); display: flex; align-items: center; justify-content: center; padding: 20px;"
      >
        <div
          class="card"
          style="width: min(980px, 100%); max-height: 85vh; overflow: auto;"
        >
          <div
            style="display: flex; justify-content: space-between; align-items: center; gap: 12px;"
          >
            <h3>중복 처리 팝업</h3>
            <button
              class="secondary"
              type="button"
              on:click={() => (duplicateModalOpen = false)}
            >
              닫기
            </button>
          </div>
          <p class="small">
            동일인으로 판단된 그룹마다 추첨 대상 1건을 선택하세요. 미처리 그룹이
            있으면 추첨을 시작할 수 없습니다.
          </p>
          <div class="grid" style="margin-top: 12px;">
            {#each [...collisions.entries()] as [key, list], i}
              <div
                style="border: 1px solid rgba(255,255,255,0.14); border-radius: 12px; padding: 12px;"
              >
                <div
                  style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 8px;"
                >
                  <b>중복 그룹 #{i + 1}</b>
                  <span
                    class="badge {(duplicateSelections.get(key)?.length ?? 0) >
                    0
                      ? 'ok'
                      : 'warn'}"
                  >
                    {(duplicateSelections.get(key)?.length ?? 0) > 0
                      ? `${duplicateSelections.get(key)?.length}건 선택`
                      : "미선택"}
                  </span>
                </div>
                <div class="grid" style="gap: 8px;">
                  {#each [...list].sort((a, b) => registrationEpoch(b.등록일) - registrationEpoch(a.등록일)) as row}
                    <label
                      style="border: 1px solid rgba(255,255,255,0.1); border-radius: 10px; padding: 10px; gap: 6px;"
                    >
                      <div
                        style="display:flex; gap: 8px; align-items: center; font-weight: 500;"
                      >
                        <input
                          type="checkbox"
                          checked={(
                            duplicateSelections.get(key) ?? []
                          ).includes(row.rowIndex)}
                          on:change={() =>
                            toggleDuplicateSelection(key, row.rowIndex)}
                        />
                        <span
                          >행 #{row.rowIndex} / 회원ID: {(
                            row.회원ID ?? ""
                          ).trim() || "-"}</span
                        >
                      </div>
                      <span class="small"
                        >이름: {(row.이름 ?? "").trim() || "-"} | 휴대전화:
                        {(row.휴대전화 ?? "").trim() || "-"} | 등록일:
                        {(row.등록일 ?? "").trim() || "-"}</span
                      >
                    </label>
                  {/each}
                </div>
              </div>
            {/each}
          </div>
          <div
            style="margin-top: 14px; display:flex; justify-content:space-between; align-items:center; gap: 12px;"
          >
            <span class="badge {unresolvedDuplicateCount() ? 'warn' : 'ok'}">
              미처리 {unresolvedDuplicateCount()}건
            </span>
            <button
              class="primary"
              type="button"
              on:click={() => (duplicateModalOpen = false)}
            >
              저장 후 닫기
            </button>
          </div>
        </div>
      </div>
    {/if}

    {#if drawResult}
      <div
        class="card grid animate-fade-in"
        style="background: rgba(52, 199, 89, 0.1); border-color: rgba(52, 199, 89, 0.3); margin-top: 24px;"
      >
        <h3 style="color: #a3e635;">추첨 완료</h3>
        <div
          class="kv"
          style="grid-template-columns: 1fr 1fr; background: rgba(0,0,0,0.2); padding: 20px; border-radius: 12px;"
        >
          <div>
            <span class="small">Run ID:</span> <br /><b
              style="word-break: break-all;">{drawResult.runId}</b
            >
          </div>
          <div>
            <span class="small">Seed Hash:</span> <br /><b
              style="word-break: break-all;">{drawResult.seedHash}</b
            >
          </div>
          <div>
            <span class="small">보장 정원:</span> <br /><b
              >{drawResult.guaranteeQuota}명</b
            >
          </div>
          <div>
            <span class="small">최종 결과:</span> <br /><b
              >당첨 {drawResult.winners.length}명 / 대기 {drawResult.waitlist
                .length}명</b
            >
          </div>
        </div>
      </div>
    {/if}
  {/if}

  {#if tab === "public"}
    <div class="public-board animate-fade-in">
      <div style="text-align: center; margin-bottom: 40px;">
        <h2
          style="font-size: 2.5rem; margin-bottom: 12px; background: linear-gradient(135deg, #60a5fa 0%, #a78bfa 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent;"
        >
          추첨 결과
        </h2>
        <p class="small" style="font-size: 1.1rem;">
          추첨 규칙: 50% 대상동 우선 배정 → 잔여 인원 전체 공개 추첨 → 단일 난수
          기반 대기번호 결정
        </p>
      </div>

      <div class="grid two" style="margin-bottom: 32px;">
        <div
          class="card"
          style="background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1);"
        >
          <h3 style="color: #93c5fd; margin-bottom: 16px;">추첨 메타데이터</h3>
          <div class="kv">
            <div style="display:flex; justify-content:space-between;">
              <span class="small">대상 행정동</span> <b>{selectedDong}</b>
            </div>
            <div style="display:flex; justify-content:space-between;">
              <span class="small">추첨 정원</span> <b>{capacity}명</b>
            </div>
            <div style="display:flex; justify-content:space-between;">
              <span class="small">유효 지원자</span>
              <b>{validApplicants.length}명</b>
            </div>
            <hr style="border-color: rgba(255,255,255,0.1); margin: 8px 0;" />
            <div style="display:flex; justify-content:space-between;">
              <span class="small">BTC 가격</span>
              <b>{finalBtcValue() || "-"}</b>
            </div>
            <div style="display:flex; justify-content:space-between;">
              <span class="small">NIST 값</span>
              <b>{finalNistValue() || "-"}</b>
            </div>
          </div>
        </div>

        <div
          class="card"
          style="background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); display: flex; flex-direction: column; justify-content: center;"
        >
          <h3 style="color: #93c5fd; text-align: center;">고유 시드 해시</h3>
          <p class="small" style="text-align: center; margin-bottom: 16px;">
            모든 당첨 결과를 재현할 수 있는 값입니다.
          </p>
          <div
            style="background: rgba(0,0,0,0.3); padding: 16px; border-radius: 12px; word-break: break-all; font-family: monospace; color: #a78bfa; text-align: center; font-size: 1.1rem; line-height: 1.4;"
          >
            {drawResult?.seedHash || "추첨을 진행해주세요"}
          </div>
        </div>
      </div>

      <div style="display: grid; gap: 32px;">
        <div
          class="card"
          style="padding: 0; overflow: hidden; background: rgba(0,0,0,0.2);"
        >
          <div
            style="padding: 24px; background: rgba(52, 199, 89, 0.15); border-bottom: 1px solid rgba(255,255,255,0.1);"
          >
            <h3
              style="color: #a3e635; margin: 0; display: flex; align-items: center; gap: 8px;"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                ><circle cx="12" cy="8" r="7" /><polyline
                  points="8.21 13.89 7 23 12 20 17 23 15.79 13.88"
                /></svg
              >
              최종 당첨자 명단
            </h3>
          </div>
          <div
            class="table-container"
            style="border-radius: 0; border: none; background: transparent;"
          >
            <table class="table">
              <thead>
                <tr
                  ><th style="width: 80px;">연번</th><th>이름</th><th
                    >휴대전화 뒷자리</th
                  ></tr
                >
              </thead>
              <tbody>
                {#if drawResult && drawResult.winners.length > 0}
                  {#each drawResult.winners.map(maskedPublicRow) as row, i}
                    <tr>
                      <td
                        ><span
                          class="badge"
                          style="background: rgba(255,255,255,0.1);"
                          >{i + 1}</span
                        ></td
                      >
                      <td style="font-weight: 600;">{row.maskedName}</td>
                      <td style="font-family: monospace; font-size: 1.1rem;"
                        >{row.phoneLast4}</td
                      >
                    </tr>
                  {/each}
                {:else}
                  <tr
                    ><td
                      colspan="3"
                      style="text-align: center; padding: 32px; color: rgba(255,255,255,0.5);"
                      >결과가 없습니다</td
                    ></tr
                  >
                {/if}
              </tbody>
            </table>
          </div>
        </div>

        <div
          class="card"
          style="padding: 0; overflow: hidden; background: rgba(0,0,0,0.2);"
        >
          <div
            style="padding: 24px; background: rgba(255, 204, 0, 0.1); border-bottom: 1px solid rgba(255,255,255,0.1);"
          >
            <h3
              style="color: #fcd34d; margin: 0; display: flex; align-items: center; gap: 8px;"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                ><circle cx="12" cy="12" r="10" /><polyline
                  points="12 6 12 12 16 14"
                /></svg
              >
              대기자 명단
            </h3>
          </div>
          <div
            class="table-container"
            style="border-radius: 0; border: none; background: transparent;"
          >
            <table class="table">
              <thead>
                <tr
                  ><th style="width: 80px;">순번</th><th>이름</th><th
                    >휴대전화 뒷자리</th
                  ></tr
                >
              </thead>
              <tbody>
                {#if drawResult && drawResult.waitlist.length > 0}
                  {#each drawResult.waitlist.map(maskedPublicRow) as row, i}
                    <tr>
                      <td
                        ><span
                          class="badge"
                          style="background: rgba(255,255,255,0.1);"
                          >{i + 1}</span
                        ></td
                      >
                      <td style="font-weight: 600;">{row.maskedName}</td>
                      <td style="font-family: monospace; font-size: 1.1rem;"
                        >{row.phoneLast4}</td
                      >
                    </tr>
                  {/each}
                {:else}
                  <tr
                    ><td
                      colspan="3"
                      style="text-align: center; padding: 32px; color: rgba(255,255,255,0.5);"
                      >결과가 없습니다</td
                    ></tr
                  >
                {/if}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  {/if}

  {#if tab === "verify"}
    <div class="grid two animate-fade-in">
      <div class="card grid">
        <h2 style="display: flex; align-items: center; gap: 8px;">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            style="color: var(--accent);"
            ><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><polyline
              points="9 12 11 14 15 10"
            /></svg
          >
          감사 파일 검증
        </h2>
        <p class="small" style="margin-bottom: 8px;">
          다운로드 받은 Zip 파일의 압축을 해제하고 내부의 json 파일들을
          등록해주세요.
        </p>

        <label>
          audit_summary.json 업로드
          <input
            type="file"
            accept=".json"
            on:change={handleVerifySummaryUpload}
          />
          {#if verifySummaryText}
            <span class="small" style="color: #a3e635;">✓ 로드 완료</span>
          {/if}
        </label>

        <label>
          audit.jsonl 업로드
          <input
            type="file"
            accept=".jsonl,.txt"
            on:change={handleVerifyJsonlUpload}
          />
          {#if verifyJsonlText}
            <span class="small" style="color: #a3e635;">✓ 로드 완료</span>
          {/if}
        </label>

        <label>
          integrity_manifest.json 업로드 (선택)
          <input
            type="file"
            accept=".json"
            on:change={handleVerifyIntegrityManifestUpload}
          />
          {#if verifyIntegrityManifestText}
            <span class="small" style="color: #a3e635;">✓ 로드 완료</span>
          {/if}
        </label>

        <label>
          integrity_manifest.sig 업로드 (선택)
          <input
            type="file"
            accept=".sig,.txt"
            on:change={handleVerifyIntegritySigUpload}
          />
          {#if verifyIntegritySigText}
            <span class="small" style="color: #a3e635;">✓ 로드 완료</span>
          {/if}
        </label>

        <label>
          integrity_public_key.jwk 업로드 (선택)
          <input
            type="file"
            accept=".json,.jwk"
            on:change={handleVerifyIntegrityPubUpload}
          />
          {#if verifyIntegrityPubText}
            <span class="small" style="color: #a3e635;">✓ 로드 완료</span>
          {/if}
        </label>

        <button
          class="primary"
          on:click={verifyAudit}
          style="margin-top: 16px; padding: 16px; font-size: 1.1rem;"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3" /></svg
          >
          해시체인 무결성 및 시스템 재현 검증
        </button>
      </div>

      <div class="card grid">
        <h2>검증 결과 보고서</h2>
        {#if verifyResult}
          <div
            style="background: rgba(0,0,0,0.2); padding: 24px; border-radius: 16px;"
          >
            <div class="kv" style="gap: 16px;">
              <div
                style="display: flex; justify-content: space-between; align-items: center; font-size: 1.1rem;"
              >
                <span>Hash Chain 무결성</span>
                <span
                  class="badge {verifyResult.chainOk ? 'ok' : 'danger'}"
                  style="padding: 6px 16px; font-size: 1rem;"
                >
                  {verifyResult.chainOk ? "PASS" : "FAIL"}
                </span>
              </div>
              <hr
                style="border: 0; border-top: 1px solid rgba(255,255,255,0.1); margin: 0;"
              />
              <div
                style="display: flex; justify-content: space-between; align-items: center; font-size: 1.1rem;"
              >
                <span>시스템 결정 재현 (Replay)</span>
                <span
                  class="badge {verifyResult.replayOk ? 'ok' : 'danger'}"
                  style="padding: 6px 16px; font-size: 1rem;"
                >
                  {verifyResult.replayOk ? "PASS" : "FAIL"}
                </span>
              </div>
              {#if integrityCheck}
                <hr
                  style="border: 0; border-top: 1px solid rgba(255,255,255,0.1); margin: 0;"
                />
                <div
                  style="display: flex; justify-content: space-between; align-items: center; font-size: 1.1rem;"
                >
                  <span>패키지 해시 무결성</span>
                  <span
                    class="badge {integrityCheck.hashOk ? 'ok' : 'danger'}"
                    style="padding: 6px 16px; font-size: 1rem;"
                  >
                    {integrityCheck.hashOk ? "PASS" : "FAIL"}
                  </span>
                </div>
                <div
                  style="display: flex; justify-content: space-between; align-items: center; font-size: 1.1rem;"
                >
                  <span>Manifest 전자서명</span>
                  <span
                    class="badge {integrityCheck.signatureOk ? 'ok' : 'danger'}"
                    style="padding: 6px 16px; font-size: 1rem;"
                  >
                    {integrityCheck.signatureOk ? "PASS" : "FAIL"}
                  </span>
                </div>
              {/if}
            </div>

            {#if verifyResult.reasons.length}
              <div style="margin-top: 24px;">
                <h4 style="color: #fca5a5; margin-bottom: 12px;">오류 상세</h4>
                <ul class="list small">
                  {#each verifyResult.reasons as reason}
                    <li
                      style="background: rgba(248, 113, 113, 0.1); border-color: rgba(248, 113, 113, 0.3); color: #fca5a5;"
                    >
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        style="min-width: 16px; margin-top: 2px;"
                        ><circle cx="12" cy="12" r="10" /><line
                          x1="12"
                          y1="8"
                          x2="12"
                          y2="12"
                        /><line x1="12" y1="16" x2="12.01" y2="16" /></svg
                      >
                      {reason}
                    </li>
                  {/each}
                </ul>
              </div>
            {/if}
            {#if integrityCheck && integrityCheck.reasons.length}
              <div style="margin-top: 16px;">
                <h4 style="color: #fca5a5; margin-bottom: 12px;">
                  패키지 무결성 상세
                </h4>
                <ul class="list small">
                  {#each integrityCheck.reasons as reason}
                    <li
                      style="background: rgba(248, 113, 113, 0.1); border-color: rgba(248, 113, 113, 0.3); color: #fca5a5;"
                    >
                      {reason}
                    </li>
                  {/each}
                </ul>
              </div>
            {/if}
          </div>
        {:else}
          <div
            style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; color: rgba(255,255,255,0.4); min-height: 200px;"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="48"
              height="48"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1"
              stroke-linecap="round"
              stroke-linejoin="round"
              style="margin-bottom: 16px;"
              ><rect width="18" height="18" x="3" y="3" rx="2" ry="2" /><line
                x1="9"
                x2="15"
                y1="15"
                y2="15"
              /><line x1="9" x2="9" y1="9" y2="9" /><line
                x1="15"
                x2="15"
                y1="9"
                y2="9"
              /></svg
            >
            <p>파일을 업로드하고 검증 버튼을 누르세요.</p>
          </div>
        {/if}
      </div>
    </div>

    <div class="card grid animate-fade-in" style="margin-top: 16px;">
      <h2 style="display: flex; align-items: center; gap: 8px;">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="22"
          height="22"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          style="color: var(--accent);"
          ><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /><line
            x1="11"
            x2="11"
            y1="8"
            y2="14"
          /><line x1="8" x2="14" y1="11" y2="11" /></svg
        >
        개인 당첨 결과 조회
      </h2>
      <p class="small">
        먼저 위의 무결성/재현 검증을 수행한 뒤, anon_id(익명 ID) 또는 회원ID를
        입력해 개인 결과를 조회하세요.
      </p>

      <div class="grid two" style="align-items: end;">
        <label>
          anon_id (익명 ID) 또는 회원ID
          <input
            bind:value={individualQuery}
            placeholder="예: e3f9... 또는 M123456"
          />
        </label>
        <button
          class="primary"
          on:click={lookupIndividual}
          disabled={!verifyResult || !individualQuery.trim()}
          style="height: fit-content; padding: 13px 16px;"
        >
          조회 및 인증서 발급
        </button>
      </div>

      {#if individualResult}
        <div
          style="margin-top: 8px; padding: 14px; border-radius: 12px; background: rgba(0,0,0,0.2);"
        >
          {#if individualResult.status === "NOT_FOUND"}
            <span class="badge danger">조회 실패</span>
            <p class="small" style="margin-top: 8px;">
              입력한 식별자가 감사 요약의 지원자 목록에서 발견되지 않았습니다.
            </p>
          {:else if individualResult.status === "WINNER"}
            <span class="badge ok">당첨자</span>
            <p class="small" style="margin-top: 8px;">
              정원 내 당첨자로 확인되었습니다. 인증서 PDF가 다운로드됩니다.
            </p>
          {:else if individualResult.status === "WAITLIST"}
            <span class="badge warn"
              >대기자 {individualResult.waitlistRank}번</span
            >
            <p class="small" style="margin-top: 8px;">
              대기자로 확인되었습니다. 인증서 PDF가 다운로드됩니다.
            </p>
          {:else}
            <span class="badge">미당첨</span>
            <p class="small" style="margin-top: 8px;">
              당첨/대기 명단에는 포함되지 않았습니다. 인증서 PDF가
              다운로드됩니다.
            </p>
          {/if}
        </div>
      {/if}
    </div>
  {/if}
</div>

{#if tab === "admin" && invalidApplicants.length > 0 && !invalidBannerDismissed}
  <div class="invalid-banner animate-fade-in">
    <div class="invalid-banner__content">
      <b>필수 항목 누락 경고</b>
      <span
        >무효 {invalidApplicants.length}명이 있어 추첨을 실행할 수 없습니다.
        (필수: 이름, 회원ID, 휴대전화, 우편번호, 주소)</span
      >
    </div>
    <button
      class="secondary"
      type="button"
      on:click={() => (invalidBannerDismissed = true)}
    >
      닫기
    </button>
  </div>
{/if}

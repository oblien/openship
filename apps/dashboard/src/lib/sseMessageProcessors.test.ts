import { describe, expect, it, vi } from "vitest";

import {
  createBuildMessageProcessor,
  createGenericMessageProcessor,
  createLogMessageProcessor,
  type BuildMessage,
  type LogMessage,
} from "./sseMessageProcessors";

// Small helper: build the context object handleMessage receives, with a
// fresh writeToTerminal spy by default so call assertions never leak
// between tests.
const makeContext = (
  overrides: {
    rawText?: string;
    rawBytes?: Uint8Array;
    writeToTerminal?: (bytes: Uint8Array) => void;
  } = {},
) => ({
  rawText: overrides.rawText,
  rawBytes: overrides.rawBytes,
  writeToTerminal: overrides.writeToTerminal ?? vi.fn(),
});

describe("createBuildMessageProcessor", () => {
  describe("parseMessage", () => {
    const processor = createBuildMessageProcessor();

    it("recognizes complete messages", () => {
      expect(processor.parseMessage({ type: "complete", success: true }).type).toBe("complete");
    });

    it("recognizes end messages", () => {
      expect(processor.parseMessage({ type: "end", exitCode: 0 }).type).toBe("end");
    });

    it("recognizes connected messages", () => {
      expect(processor.parseMessage({ type: "connected", running: true }).type).toBe("connected");
    });

    it("recognizes error messages when success is not set", () => {
      // The branch is guarded by `!jsonData?.success`, so a bare error type
      // (no success field at all) must still classify as "error".
      expect(processor.parseMessage({ type: "error", error: "boom" }).type).toBe("error");
    });

    it("does not take the error branch when success is true", () => {
      // type === "error" && success === true skips the error branch's guard.
      // The value falls through to the `success === true` catch-all, whose
      // literal "success" is then overwritten by the spread of jsonData
      // (which still carries type: "error"), so the final type stays
      // "error". This is a real quirk of the source: every early return in
      // this function spreads `...jsonData` AFTER the literal `type`, so any
      // incoming `type` field wins whenever the object already has one.
      expect(processor.parseMessage({ type: "error", success: true }).type).toBe("error");
    });

    it("recognizes service-status messages", () => {
      const result = processor.parseMessage({
        type: "service-status",
        serviceName: "web",
        serviceId: "svc-1",
        status: "building",
      });
      expect(result.type).toBe("service-status");
      expect(result.serviceName).toBe("web");
    });

    it("recognizes prompt messages", () => {
      expect(
        processor.parseMessage({ type: "prompt", promptId: "p1", message: "Continue?" }).type,
      ).toBe("prompt");
    });

    it("recognizes reconnected messages", () => {
      expect(processor.parseMessage({ type: "reconnected" }).type).toBe("reconnected");
    });

    it("recognizes cancelled messages", () => {
      expect(processor.parseMessage({ type: "cancelled" }).type).toBe("cancelled");
    });

    it("recognizes started messages", () => {
      expect(processor.parseMessage({ type: "started" }).type).toBe("started");
    });

    it("recognizes log messages only when data is present", () => {
      expect(processor.parseMessage({ type: "log", data: "aGVsbG8=" }).type).toBe("log");
    });

    it("does not take the log branch when data is missing", () => {
      // type === "log" without a `data` field skips the dedicated log
      // branch (it requires jsonData?.data). It falls all the way to the
      // final "unknown" fallback, whose literal is then overwritten back to
      // "log" by the trailing spread - so the final type still reads "log",
      // just via a different code path than the dedicated branch.
      expect(processor.parseMessage({ type: "log" }).type).toBe("log");
    });

    it("recognizes progress messages by explicit type", () => {
      expect(processor.parseMessage({ type: "progress", progress: 50 }).type).toBe("progress");
    });

    it("recognizes success via the success:true catch-all when no type is set", () => {
      expect(processor.parseMessage({ success: true, message: "done" }).type).toBe("success");
    });

    it("recognizes failure via the success:false catch-all when no type is set", () => {
      expect(processor.parseMessage({ success: false, error: "nope" }).type).toBe("failure");
    });

    it("recognizes phase via a bare phase field when no type is set", () => {
      expect(processor.parseMessage({ phase: "building" }).type).toBe("phase");
    });

    it("does not relabel type when phase is set but an unrelated type already exists", () => {
      // Same spread-order quirk as above: an unrecognized `type` plus a
      // `phase` field reaches the phase branch's condition, but the
      // trailing `...jsonData` spread restores the original (unrecognized)
      // type instead of "phase".
      expect(processor.parseMessage({ type: "weird-thing", phase: "building" }).type).toBe(
        "weird-thing",
      );
    });

    it("recognizes progress via bare currentStep/progress fields when no type is set", () => {
      expect(processor.parseMessage({ currentStep: 2 }).type).toBe("progress");
      expect(processor.parseMessage({ progress: 10 }).type).toBe("progress");
    });

    it("falls back to unknown for an empty object", () => {
      expect(processor.parseMessage({}).type).toBe("unknown");
    });

    it("falls back to unknown without throwing for null or undefined input", () => {
      expect(processor.parseMessage(null).type).toBe("unknown");
      expect(processor.parseMessage(undefined).type).toBe("unknown");
    });

    it("does not relabel an unrecognized type to unknown", () => {
      // The clearest demonstration of the spread-order quirk: nothing else
      // matches, so the function intends to label this "unknown", but the
      // incoming `type` field survives the trailing spread untouched.
      expect(processor.parseMessage({ type: "totally-custom" }).type).toBe("totally-custom");
    });

    it("does not validate the type field's runtime type", () => {
      // The BuildMessage interface declares `type` as a string union, but
      // nothing at runtime enforces that - a non-string type field is
      // spread straight through.
      expect(processor.parseMessage({ type: 123 }).type).toBe(123);
    });

    it("spreads all other fields through unchanged", () => {
      const result = processor.parseMessage({
        type: "complete",
        success: true,
        message: "ok",
        extra: "unrecognized-but-preserved",
      });
      expect(result).toMatchObject({
        type: "complete",
        success: true,
        message: "ok",
        extra: "unrecognized-but-preserved",
      });
    });
  });

  describe("handleMessage", () => {
    it("does not throw when no callbacks are provided, for every recognized type", () => {
      const processor = createBuildMessageProcessor();
      const types: BuildMessage["type"][] = [
        "log",
        "success",
        "failure",
        "phase",
        "progress",
        "reconnected",
        "complete",
        "end",
        "connected",
        "started",
        "error",
        "cancelled",
        "prompt",
        "service-status",
        "unknown",
      ];
      for (const type of types) {
        expect(() =>
          processor.handleMessage({ type } as BuildMessage, makeContext()),
        ).not.toThrow();
      }
    });

    describe("complete", () => {
      it("calls onSuccess with the message when success is true", () => {
        const onSuccess = vi.fn();
        const processor = createBuildMessageProcessor({ onSuccess });
        const message = { type: "complete", success: true } as BuildMessage;
        processor.handleMessage(message, makeContext());
        expect(onSuccess).toHaveBeenCalledWith(message);
      });

      it("calls onFailure using message, then error, then a default, when success is false", () => {
        const processor = createBuildMessageProcessor({});
        const onFailure = vi.fn();

        createBuildMessageProcessor({ onFailure }).handleMessage(
          { type: "complete", success: false, message: "custom failure" } as BuildMessage,
          makeContext(),
        );
        expect(onFailure).toHaveBeenCalledWith("custom failure", undefined, undefined);

        onFailure.mockClear();
        createBuildMessageProcessor({ onFailure }).handleMessage(
          { type: "complete", success: false, error: "err text" } as BuildMessage,
          makeContext(),
        );
        expect(onFailure).toHaveBeenCalledWith("err text", undefined, undefined);

        onFailure.mockClear();
        createBuildMessageProcessor({ onFailure }).handleMessage(
          {
            type: "complete",
            success: false,
            errorCode: "E1",
            errorDetails: { reason: "dummy" },
          } as BuildMessage,
          makeContext(),
        );
        expect(onFailure).toHaveBeenCalledWith("Build completed with errors", "E1", {
          reason: "dummy",
        });
      });

      it("calls neither onSuccess nor onFailure when success is left undefined", () => {
        // Only strict === true / === false branches are handled; a
        // "complete" message with no success field does nothing.
        const onSuccess = vi.fn();
        const onFailure = vi.fn();
        const processor = createBuildMessageProcessor({ onSuccess, onFailure });
        processor.handleMessage({ type: "complete" } as BuildMessage, makeContext());
        expect(onSuccess).not.toHaveBeenCalled();
        expect(onFailure).not.toHaveBeenCalled();
      });
    });

    describe("reconnected", () => {
      it("calls onReconnected with no arguments", () => {
        const onReconnected = vi.fn();
        const processor = createBuildMessageProcessor({ onReconnected });
        processor.handleMessage({ type: "reconnected" } as BuildMessage, makeContext());
        expect(onReconnected).toHaveBeenCalledWith();
      });
    });

    describe("progress", () => {
      it("calls onProgress only when both currentStep and progress are defined", () => {
        const onProgress = vi.fn();
        const processor = createBuildMessageProcessor({ onProgress });

        processor.handleMessage(
          { type: "progress", currentStep: 2, progress: 40 } as BuildMessage,
          makeContext(),
        );
        expect(onProgress).toHaveBeenCalledWith(2, 40);

        onProgress.mockClear();
        processor.handleMessage(
          { type: "progress", currentStep: 2 } as BuildMessage,
          makeContext(),
        );
        expect(onProgress).not.toHaveBeenCalled();

        onProgress.mockClear();
        processor.handleMessage({ type: "progress", progress: 40 } as BuildMessage, makeContext());
        expect(onProgress).not.toHaveBeenCalled();
      });

      it("also writes to the terminal and calls onLog when data and rawBytes are present", () => {
        const onLog = vi.fn();
        const writeToTerminal = vi.fn();
        const processor = createBuildMessageProcessor({ onLog });
        const rawBytes = new Uint8Array([1, 2, 3]);
        const message = {
          type: "progress",
          data: "encoded",
          currentStep: 1,
          progress: 10,
        } as BuildMessage;

        processor.handleMessage(
          message,
          makeContext({ rawText: "decoded", rawBytes, writeToTerminal }),
        );

        expect(writeToTerminal).toHaveBeenCalledWith(rawBytes);
        expect(onLog).toHaveBeenCalledWith(message, "decoded", rawBytes);
      });

      it("does not log when data is present but rawBytes is missing", () => {
        const onLog = vi.fn();
        const writeToTerminal = vi.fn();
        const processor = createBuildMessageProcessor({ onLog });
        processor.handleMessage(
          { type: "progress", data: "encoded" } as BuildMessage,
          makeContext({ writeToTerminal }),
        );
        expect(writeToTerminal).not.toHaveBeenCalled();
        expect(onLog).not.toHaveBeenCalled();
      });
    });

    describe("success", () => {
      it("calls onSuccess with the full message", () => {
        const onSuccess = vi.fn();
        const processor = createBuildMessageProcessor({ onSuccess });
        const message = { type: "success", data: "ignored" } as BuildMessage;
        processor.handleMessage(message, makeContext());
        expect(onSuccess).toHaveBeenCalledWith(message);
      });
    });

    describe("failure", () => {
      it("prefers message over error, and passes through errorCode/errorDetails", () => {
        const onFailure = vi.fn();
        const processor = createBuildMessageProcessor({ onFailure });
        processor.handleMessage(
          {
            type: "failure",
            message: "human message",
            error: "raw error",
            errorCode: "E2",
            errorDetails: { hint: "dummy" },
          } as BuildMessage,
          makeContext(),
        );
        expect(onFailure).toHaveBeenCalledWith("human message", "E2", { hint: "dummy" });
      });

      it("falls back to error when message is absent", () => {
        const onFailure = vi.fn();
        const processor = createBuildMessageProcessor({ onFailure });
        processor.handleMessage(
          { type: "failure", error: "raw error" } as BuildMessage,
          makeContext(),
        );
        expect(onFailure).toHaveBeenCalledWith("raw error", undefined, undefined);
      });

      it("passes undefined when neither message nor error is set", () => {
        const onFailure = vi.fn();
        const processor = createBuildMessageProcessor({ onFailure });
        processor.handleMessage({ type: "failure" } as BuildMessage, makeContext());
        expect(onFailure).toHaveBeenCalledWith(undefined, undefined, undefined);
      });
    });

    describe("cancelled", () => {
      it("uses message.message when present", () => {
        const onCanceled = vi.fn();
        const processor = createBuildMessageProcessor({ onCanceled });
        processor.handleMessage(
          { type: "cancelled", message: "stopped by ci" } as BuildMessage,
          makeContext(),
        );
        expect(onCanceled).toHaveBeenCalledWith("stopped by ci");
      });

      it("defaults to 'Build cancelled by user' otherwise", () => {
        const onCanceled = vi.fn();
        const processor = createBuildMessageProcessor({ onCanceled });
        processor.handleMessage({ type: "cancelled" } as BuildMessage, makeContext());
        expect(onCanceled).toHaveBeenCalledWith("Build cancelled by user");
      });
    });

    describe("phase", () => {
      it("calls onPhaseChange with the phase", () => {
        const onPhaseChange = vi.fn();
        const processor = createBuildMessageProcessor({ onPhaseChange });
        processor.handleMessage(
          { type: "phase", phase: "installing" } as BuildMessage,
          makeContext(),
        );
        expect(onPhaseChange).toHaveBeenCalledWith("installing");
      });

      it("calls onPhaseChange with undefined when phase is missing (non-null assertion is not a runtime guard)", () => {
        // `message.phase!` only silences TypeScript; at runtime nothing
        // stops onPhaseChange from firing with undefined.
        const onPhaseChange = vi.fn();
        const processor = createBuildMessageProcessor({ onPhaseChange });
        processor.handleMessage({ type: "phase" } as BuildMessage, makeContext());
        expect(onPhaseChange).toHaveBeenCalledWith(undefined);
      });

      it("also writes to the terminal and calls onLog when data and rawBytes are present", () => {
        const onLog = vi.fn();
        const writeToTerminal = vi.fn();
        const processor = createBuildMessageProcessor({ onLog });
        const rawBytes = new Uint8Array([9, 9]);
        const message = { type: "phase", phase: "building", data: "encoded" } as BuildMessage;

        processor.handleMessage(
          message,
          makeContext({ rawText: "log line", rawBytes, writeToTerminal }),
        );

        expect(writeToTerminal).toHaveBeenCalledWith(rawBytes);
        expect(onLog).toHaveBeenCalledWith(message, "log line", rawBytes);
      });
    });

    describe("log", () => {
      it("writes to the terminal and calls onLog when data and rawBytes are present", () => {
        const onLog = vi.fn();
        const writeToTerminal = vi.fn();
        const processor = createBuildMessageProcessor({ onLog });
        const rawBytes = new Uint8Array([5]);
        const message = { type: "log", data: "encoded" } as BuildMessage;

        processor.handleMessage(
          message,
          makeContext({ rawText: "hello", rawBytes, writeToTerminal }),
        );

        expect(writeToTerminal).toHaveBeenCalledWith(rawBytes);
        expect(onLog).toHaveBeenCalledWith(message, "hello", rawBytes);
      });

      it("does nothing when data is missing", () => {
        const onLog = vi.fn();
        const writeToTerminal = vi.fn();
        const processor = createBuildMessageProcessor({ onLog });
        processor.handleMessage({ type: "log" } as BuildMessage, makeContext({ writeToTerminal }));
        expect(writeToTerminal).not.toHaveBeenCalled();
        expect(onLog).not.toHaveBeenCalled();
      });

      it("does nothing when data is present but rawBytes is missing", () => {
        const onLog = vi.fn();
        const writeToTerminal = vi.fn();
        const processor = createBuildMessageProcessor({ onLog });
        processor.handleMessage(
          { type: "log", data: "encoded" } as BuildMessage,
          makeContext({ writeToTerminal }),
        );
        expect(writeToTerminal).not.toHaveBeenCalled();
        expect(onLog).not.toHaveBeenCalled();
      });
    });

    describe("end", () => {
      it("calls onContainerExit for a non-zero exit code, using the message text", () => {
        const onContainerExit = vi.fn();
        const processor = createBuildMessageProcessor({ onContainerExit });
        processor.handleMessage(
          { type: "end", exitCode: 137, message: "oom killed" } as BuildMessage,
          makeContext(),
        );
        expect(onContainerExit).toHaveBeenCalledWith(137, "oom killed");
      });

      it("defaults the exit message when message is absent", () => {
        const onContainerExit = vi.fn();
        const processor = createBuildMessageProcessor({ onContainerExit });
        processor.handleMessage({ type: "end", exitCode: 1 } as BuildMessage, makeContext());
        expect(onContainerExit).toHaveBeenCalledWith(1, "Container exited with code 1");
      });

      it("does not call onContainerExit for a zero exit code", () => {
        const onContainerExit = vi.fn();
        const processor = createBuildMessageProcessor({ onContainerExit });
        processor.handleMessage({ type: "end", exitCode: 0 } as BuildMessage, makeContext());
        expect(onContainerExit).not.toHaveBeenCalled();
      });

      it("does not call onContainerExit when exitCode is missing", () => {
        const onContainerExit = vi.fn();
        const processor = createBuildMessageProcessor({ onContainerExit });
        processor.handleMessage({ type: "end" } as BuildMessage, makeContext());
        expect(onContainerExit).not.toHaveBeenCalled();
      });
    });

    describe("connected", () => {
      it("calls onContainerExit when running is false with a non-zero exitCode", () => {
        const onContainerExit = vi.fn();
        const processor = createBuildMessageProcessor({ onContainerExit });
        processor.handleMessage(
          { type: "connected", running: false, exitCode: 2 } as BuildMessage,
          makeContext(),
        );
        expect(onContainerExit).toHaveBeenCalledWith(2, "Container not running (exit code: 2)");
      });

      it("does not call onContainerExit when running is true", () => {
        const onContainerExit = vi.fn();
        const processor = createBuildMessageProcessor({ onContainerExit });
        processor.handleMessage(
          { type: "connected", running: true, exitCode: 2 } as BuildMessage,
          makeContext(),
        );
        expect(onContainerExit).not.toHaveBeenCalled();
      });

      it("does not call onContainerExit when exitCode is 0", () => {
        const onContainerExit = vi.fn();
        const processor = createBuildMessageProcessor({ onContainerExit });
        processor.handleMessage(
          { type: "connected", running: false, exitCode: 0 } as BuildMessage,
          makeContext(),
        );
        expect(onContainerExit).not.toHaveBeenCalled();
      });

      it("does not call onContainerExit when exitCode is missing", () => {
        const onContainerExit = vi.fn();
        const processor = createBuildMessageProcessor({ onContainerExit });
        processor.handleMessage(
          { type: "connected", running: false } as BuildMessage,
          makeContext(),
        );
        expect(onContainerExit).not.toHaveBeenCalled();
      });
    });

    describe("error", () => {
      it("prefers error over message, and is unconditional (no success check)", () => {
        const onFailure = vi.fn();
        const processor = createBuildMessageProcessor({ onFailure });
        processor.handleMessage(
          {
            type: "error",
            error: "raw error",
            message: "human message",
            errorCode: "E3",
            errorDetails: { hint: "dummy" },
          } as BuildMessage,
          makeContext(),
        );
        expect(onFailure).toHaveBeenCalledWith("raw error", "E3", { hint: "dummy" });
      });

      it("falls back to message, then a default, in that order", () => {
        const onFailure = vi.fn();
        const processor = createBuildMessageProcessor({ onFailure });

        processor.handleMessage(
          { type: "error", message: "human message" } as BuildMessage,
          makeContext(),
        );
        expect(onFailure).toHaveBeenCalledWith("human message", undefined, undefined);

        onFailure.mockClear();
        processor.handleMessage({ type: "error" } as BuildMessage, makeContext());
        expect(onFailure).toHaveBeenCalledWith("Container error occurred", undefined, undefined);
      });
    });

    describe("prompt", () => {
      it("calls onPrompt only when both promptId and message are present", () => {
        const onPrompt = vi.fn();
        const processor = createBuildMessageProcessor({ onPrompt });

        processor.handleMessage({ type: "prompt", promptId: "p1" } as BuildMessage, makeContext());
        expect(onPrompt).not.toHaveBeenCalled();

        processor.handleMessage(
          { type: "prompt", message: "Continue?" } as BuildMessage,
          makeContext(),
        );
        expect(onPrompt).not.toHaveBeenCalled();
      });

      it("defaults title to 'Action Required' and actions to an empty array", () => {
        const onPrompt = vi.fn();
        const processor = createBuildMessageProcessor({ onPrompt });
        processor.handleMessage(
          { type: "prompt", promptId: "p1", message: "Continue?" } as BuildMessage,
          makeContext(),
        );
        expect(onPrompt).toHaveBeenCalledWith({
          promptId: "p1",
          title: "Action Required",
          message: "Continue?",
          actions: [],
          details: undefined,
        });
      });

      it("passes through explicit title, actions, and details", () => {
        const onPrompt = vi.fn();
        const processor = createBuildMessageProcessor({ onPrompt });
        const actions = [{ id: "a1", label: "Keep", variant: "primary" }];
        processor.handleMessage(
          {
            type: "prompt",
            promptId: "p1",
            title: "Deploy failed on one service",
            message: "Keep or roll back?",
            actions,
            details: { serviceId: "dummy-svc" },
          } as BuildMessage,
          makeContext(),
        );
        expect(onPrompt).toHaveBeenCalledWith({
          promptId: "p1",
          title: "Deploy failed on one service",
          message: "Keep or roll back?",
          actions,
          details: { serviceId: "dummy-svc" },
        });
      });
    });

    describe("started", () => {
      it("does nothing (acknowledged only)", () => {
        const callbacks = {
          onLog: vi.fn(),
          onSuccess: vi.fn(),
          onFailure: vi.fn(),
        };
        const processor = createBuildMessageProcessor(callbacks);
        processor.handleMessage({ type: "started" } as BuildMessage, makeContext());
        expect(callbacks.onLog).not.toHaveBeenCalled();
        expect(callbacks.onSuccess).not.toHaveBeenCalled();
        expect(callbacks.onFailure).not.toHaveBeenCalled();
      });
    });

    describe("service-status", () => {
      it("passes fields through as-is when present", () => {
        const onServiceStatus = vi.fn();
        const processor = createBuildMessageProcessor({ onServiceStatus });
        processor.handleMessage(
          {
            type: "service-status",
            serviceName: "web",
            serviceId: "svc-1",
            status: "running",
            error: "dummy error",
            containerId: "container-abc",
            hostPort: 8080,
          } as BuildMessage,
          makeContext(),
        );
        expect(onServiceStatus).toHaveBeenCalledWith({
          serviceName: "web",
          serviceId: "svc-1",
          status: "running",
          error: "dummy error",
          containerId: "container-abc",
          hostPort: 8080,
        });
      });

      it("defaults serviceName/serviceId to empty strings and status to pending", () => {
        // Pinning the `??` fallbacks: unlike `||`, these only kick in for
        // null/undefined, not falsy strings - but with nothing set at all
        // the defaults are what fire.
        const onServiceStatus = vi.fn();
        const processor = createBuildMessageProcessor({ onServiceStatus });
        processor.handleMessage({ type: "service-status" } as BuildMessage, makeContext());
        expect(onServiceStatus).toHaveBeenCalledWith({
          serviceName: "",
          serviceId: "",
          status: "pending",
          error: undefined,
          containerId: undefined,
          hostPort: undefined,
        });
      });
    });

    describe("return value", () => {
      it("always returns true, even for unrecognized types (no branch ever returns false)", () => {
        const processor = createBuildMessageProcessor();
        const types: BuildMessage["type"][] = [
          "log",
          "success",
          "failure",
          "phase",
          "progress",
          "reconnected",
          "complete",
          "end",
          "connected",
          "started",
          "error",
          "cancelled",
          "prompt",
          "service-status",
          "unknown",
        ];
        for (const type of types) {
          expect(processor.handleMessage({ type } as BuildMessage, makeContext())).toBe(true);
        }
      });
    });
  });
});

describe("createLogMessageProcessor", () => {
  describe("parseMessage", () => {
    const processor = createLogMessageProcessor();

    it("recognizes connected messages", () => {
      expect(processor.parseMessage({ type: "connected" }).type).toBe("connected");
    });

    it("recognizes error messages regardless of a success field", () => {
      // Unlike the build processor, this error branch has no success guard.
      expect(processor.parseMessage({ type: "error", success: true }).type).toBe("error");
    });

    it("recognizes end messages", () => {
      expect(processor.parseMessage({ type: "end" }).type).toBe("end");
    });

    it("recognizes log messages by explicit type", () => {
      expect(processor.parseMessage({ type: "log" }).type).toBe("log");
    });

    it("recognizes log messages by the presence of data alone, with no type field", () => {
      expect(processor.parseMessage({ data: "aGVsbG8=" }).type).toBe("log");
    });

    it("falls back to unknown for an empty object, null, or undefined", () => {
      expect(processor.parseMessage({}).type).toBe("unknown");
      expect(processor.parseMessage(null).type).toBe("unknown");
      expect(processor.parseMessage(undefined).type).toBe("unknown");
    });

    it("does not relabel an unrecognized type to unknown (same trailing-spread quirk as the build processor)", () => {
      expect(processor.parseMessage({ type: "totally-custom" }).type).toBe("totally-custom");
    });
  });

  describe("handleMessage", () => {
    it("does not throw when no callbacks are provided, for every recognized type", () => {
      const processor = createLogMessageProcessor();
      const types: LogMessage["type"][] = ["log", "connected", "end", "error", "unknown"];
      for (const type of types) {
        expect(() => processor.handleMessage({ type } as LogMessage, makeContext())).not.toThrow();
      }
    });

    describe("log", () => {
      it("writes raw bytes and calls onLog with the raw context when data and rawBytes are present", () => {
        const onLog = vi.fn();
        const writeToTerminal = vi.fn();
        const processor = createLogMessageProcessor({ onLog });
        const rawBytes = new Uint8Array([7, 7]);
        const message = { type: "log", data: "encoded", message: "ignored fallback" } as LogMessage;

        processor.handleMessage(
          message,
          makeContext({ rawText: "decoded text", rawBytes, writeToTerminal }),
        );

        expect(writeToTerminal).toHaveBeenCalledWith(rawBytes);
        expect(onLog).toHaveBeenCalledWith(message, "decoded text", rawBytes);
      });

      it("falls back to encoding message.message when data/rawBytes are absent", () => {
        // This branch ignores context.rawText/rawBytes entirely and derives
        // its own text/bytes from message.message via TextEncoder.
        const onLog = vi.fn();
        const writeToTerminal = vi.fn();
        const processor = createLogMessageProcessor({ onLog });
        const message = { type: "log", message: "plain text line" } as LogMessage;

        processor.handleMessage(
          message,
          makeContext({ rawText: "should be ignored", writeToTerminal }),
        );

        expect(writeToTerminal).toHaveBeenCalledTimes(1);
        const writtenBytes = writeToTerminal.mock.calls[0][0] as Uint8Array;
        expect(new TextDecoder().decode(writtenBytes)).toBe("plain text line");

        expect(onLog).toHaveBeenCalledTimes(1);
        const [loggedMessage, loggedText, loggedBytes] = onLog.mock.calls[0];
        expect(loggedMessage).toBe(message);
        expect(loggedText).toBe("plain text line");
        expect(new TextDecoder().decode(loggedBytes as Uint8Array)).toBe("plain text line");
      });

      it("does nothing when neither data+rawBytes nor message.message are present", () => {
        const onLog = vi.fn();
        const writeToTerminal = vi.fn();
        const processor = createLogMessageProcessor({ onLog });
        processor.handleMessage({ type: "log" } as LogMessage, makeContext({ writeToTerminal }));
        expect(writeToTerminal).not.toHaveBeenCalled();
        expect(onLog).not.toHaveBeenCalled();
      });
    });

    describe("connected", () => {
      it("calls onContainerExit when running is false with a non-zero exitCode", () => {
        const onContainerExit = vi.fn();
        const processor = createLogMessageProcessor({ onContainerExit });
        processor.handleMessage(
          { type: "connected", running: false, exitCode: 3 } as LogMessage,
          makeContext(),
        );
        expect(onContainerExit).toHaveBeenCalledWith(3, "Container not running (exit code: 3)");
      });

      it("does not call onContainerExit when running is true or exitCode is 0/missing", () => {
        const onContainerExit = vi.fn();
        const processor = createLogMessageProcessor({ onContainerExit });

        processor.handleMessage(
          { type: "connected", running: true, exitCode: 3 } as LogMessage,
          makeContext(),
        );
        processor.handleMessage(
          { type: "connected", running: false, exitCode: 0 } as LogMessage,
          makeContext(),
        );
        processor.handleMessage({ type: "connected", running: false } as LogMessage, makeContext());

        expect(onContainerExit).not.toHaveBeenCalled();
      });
    });

    describe("end", () => {
      it("calls onContainerExit for a non-zero exit code, preferring message.message", () => {
        const onContainerExit = vi.fn();
        const processor = createLogMessageProcessor({ onContainerExit });
        processor.handleMessage(
          { type: "end", exitCode: 137, message: "oom killed" } as LogMessage,
          makeContext(),
        );
        expect(onContainerExit).toHaveBeenCalledWith(137, "oom killed");
      });

      it("defaults the exit message and skips a zero/missing exit code", () => {
        const onContainerExit = vi.fn();
        const processor = createLogMessageProcessor({ onContainerExit });

        processor.handleMessage({ type: "end", exitCode: 1 } as LogMessage, makeContext());
        expect(onContainerExit).toHaveBeenCalledWith(1, "Container exited with code 1");

        onContainerExit.mockClear();
        processor.handleMessage({ type: "end", exitCode: 0 } as LogMessage, makeContext());
        processor.handleMessage({ type: "end" } as LogMessage, makeContext());
        expect(onContainerExit).not.toHaveBeenCalled();
      });
    });

    describe("error", () => {
      it("calls onError with error, then message, then a default - and only the string, unlike the build processor", () => {
        const onError = vi.fn();
        const processor = createLogMessageProcessor({ onError });

        processor.handleMessage(
          { type: "error", error: "raw error", message: "human message" } as LogMessage,
          makeContext(),
        );
        expect(onError).toHaveBeenCalledWith("raw error");

        onError.mockClear();
        processor.handleMessage(
          { type: "error", message: "human message" } as LogMessage,
          makeContext(),
        );
        expect(onError).toHaveBeenCalledWith("human message");

        onError.mockClear();
        processor.handleMessage({ type: "error" } as LogMessage, makeContext());
        expect(onError).toHaveBeenCalledWith("Container error occurred");
      });
    });

    describe("return value", () => {
      it("always returns true, even for unrecognized types", () => {
        const processor = createLogMessageProcessor();
        const types: LogMessage["type"][] = ["log", "connected", "end", "error", "unknown"];
        for (const type of types) {
          expect(processor.handleMessage({ type } as LogMessage, makeContext())).toBe(true);
        }
      });
    });
  });
});

describe("createGenericMessageProcessor", () => {
  describe("parseMessage", () => {
    it("uses the incoming type when present", () => {
      const processor = createGenericMessageProcessor();
      expect(processor.parseMessage({ type: "custom-event" }).type).toBe("custom-event");
    });

    it("defaults to 'message' when jsonData has no type key at all", () => {
      const processor = createGenericMessageProcessor();
      expect(processor.parseMessage({}).type).toBe("message");
      expect(processor.parseMessage(null).type).toBe("message");
      expect(processor.parseMessage(undefined).type).toBe("message");
    });

    it("does not fall back to 'message' when a type key exists but is falsy", () => {
      // `jsonData?.type || "message"` picks "message" for a falsy type, but
      // the trailing `...jsonData` spread still carries the original
      // (falsy) `type` key, which wins over the literal. Net effect: an
      // empty-string or null `type` field survives as-is instead of being
      // defaulted.
      const processor = createGenericMessageProcessor();
      expect(processor.parseMessage({ type: "" }).type).toBe("");
      expect(processor.parseMessage({ type: null }).type).toBe(null);
    });

    it("spreads all other fields through unchanged", () => {
      const processor = createGenericMessageProcessor();
      const result = processor.parseMessage({ type: "custom-event", foo: "dummy-value" });
      expect(result).toMatchObject({ type: "custom-event", foo: "dummy-value" });
    });
  });

  describe("handleMessage", () => {
    it("calls onMessage with the parsed message and the full context", () => {
      const onMessage = vi.fn();
      const processor = createGenericMessageProcessor(onMessage);
      const message = { type: "custom-event" };
      const context = makeContext({ rawText: "raw", rawBytes: new Uint8Array([1]) });

      const result = processor.handleMessage(message, context);

      expect(onMessage).toHaveBeenCalledWith(message, context);
      expect(result).toBe(true);
    });

    it("does not throw and still returns true when onMessage is omitted", () => {
      const processor = createGenericMessageProcessor();
      expect(() =>
        expect(processor.handleMessage({ type: "custom-event" }, makeContext())).toBe(true),
      ).not.toThrow();
    });
  });
});

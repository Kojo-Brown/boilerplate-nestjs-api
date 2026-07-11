import { Test, TestingModule } from "@nestjs/testing";
import { ShutdownService } from "./shutdown.service";

describe("ShutdownService", () => {
  let service: ShutdownService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [ShutdownService],
    }).compile();

    service = module.get<ShutdownService>(ShutdownService);
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });

  it("onApplicationShutdown logs the received signal", () => {
    const logSpy = jest.spyOn(service["logger"], "log").mockImplementation(() => undefined);
    service.onApplicationShutdown("SIGTERM");
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("SIGTERM"));
  });

  it("handles undefined signal gracefully", () => {
    const logSpy = jest.spyOn(service["logger"], "log").mockImplementation(() => undefined);
    service.onApplicationShutdown(undefined);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("unknown"));
  });
});

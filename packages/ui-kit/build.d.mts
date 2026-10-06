export declare const KIT_MAX_JS_BYTES: number;
export declare function newestSourceMtime(): Promise<number>;
export declare function kitIsStale(outDir?: string): Promise<boolean>;
export declare function buildKit(options?: { outDir?: string }): Promise<{ outDir: string; jsBytes: number; cssBytes: number }>;

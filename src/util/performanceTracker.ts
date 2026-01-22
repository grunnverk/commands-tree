import type { ExecutionMetrics } from '@grunnverk/tree-execution';

/**
 * PerformanceTracker collects and analyzes performance metrics
 */
export class PerformanceTracker {
    private startTime: number;
    private packageStartTimes = new Map<string, number>();
    private packageEndTimes = new Map<string, number>();
    private concurrencyHistory: number[] = [];

    constructor() {
        this.startTime = Date.now();
    }

    /**
     * Record package start
     */
    recordPackageStart(packageName: string): void {
        this.packageStartTimes.set(packageName, Date.now());
    }

    /**
     * Record package end
     */
    recordPackageEnd(packageName: string): void {
        this.packageEndTimes.set(packageName, Date.now());
    }

    /**
     * Record concurrency level
     */
    recordConcurrency(level: number): void {
        this.concurrencyHistory.push(level);
    }

    /**
     * Calculate comprehensive metrics
     */
    calculateMetrics(_maxConcurrency: number): ExecutionMetrics {
        const totalDuration = Date.now() - this.startTime;
        const durations = this.getPackageDurations();

        const averageDuration = durations.length > 0
            ? durations.reduce((a, b) => a + b, 0) / durations.length
            : 0;

        const peakConcurrency = this.concurrencyHistory.length > 0
            ? Math.max(...this.concurrencyHistory)
            : 0;

        const averageConcurrency = this.concurrencyHistory.length > 0
            ? this.concurrencyHistory.reduce((a, b) => a + b, 0) / this.concurrencyHistory.length
            : 0;

        // Calculate speedup vs sequential
        const totalCPUTime = durations.reduce((a, b) => a + b, 0);
        const speedupVsSequential = totalDuration > 0 ? totalCPUTime / totalDuration : 1;

        return {
            totalDuration,
            averagePackageDuration: averageDuration,
            peakConcurrency,
            averageConcurrency,
            speedupVsSequential
        };
    }

    /**
     * Get package durations
     */
    private getPackageDurations(): number[] {
        const durations: number[] = [];

        for (const [pkg, startTime] of this.packageStartTimes) {
            const endTime = this.packageEndTimes.get(pkg);
            if (endTime) {
                durations.push(endTime - startTime);
            }
        }

        return durations;
    }

    /**
     * Get efficiency metrics
     */
    getEfficiency(maxConcurrency: number): {
        utilization: number;
        efficiency: number;
        parallelEfficiency: number;
    } {
        const durations = this.getPackageDurations();
        const totalDuration = Date.now() - this.startTime;
        const totalCPUTime = durations.reduce((a, b) => a + b, 0);

        const utilization = this.concurrencyHistory.length > 0
            ? (this.concurrencyHistory.reduce((a, b) => a + b, 0) / this.concurrencyHistory.length) / maxConcurrency * 100
            : 0;

        const efficiency = totalDuration > 0
            ? (totalCPUTime / (totalDuration * maxConcurrency)) * 100
            : 0;

        const speedup = totalDuration > 0 ? totalCPUTime / totalDuration : 1;
        const idealSpeedup = maxConcurrency;
        const parallelEfficiency = (speedup / idealSpeedup) * 100;

        return {
            utilization,
            efficiency,
            parallelEfficiency
        };
    }

    /**
     * Generate performance report
     */
    generateReport(maxConcurrency: number): string {
        const metrics = this.calculateMetrics(maxConcurrency);
        const efficiency = this.getEfficiency(maxConcurrency);
        const durations = this.getPackageDurations();

        const lines: string[] = [];

        lines.push('');
        lines.push('═══════════════════════════════════════════');
        lines.push('        Performance Report');
        lines.push('═══════════════════════════════════════════');
        lines.push('');

        lines.push('⏱️  Timing:');
        lines.push(`  Total Execution:   ${this.formatDuration(metrics.totalDuration)}`);
        lines.push(`  Avg Per Package:   ${this.formatDuration(metrics.averagePackageDuration)}`);

        if (durations.length > 0) {
            lines.push(`  Fastest Package:   ${this.formatDuration(Math.min(...durations))}`);
            lines.push(`  Slowest Package:   ${this.formatDuration(Math.max(...durations))}`);
        }

        lines.push('');

        lines.push('🔥 Concurrency:');
        lines.push(`  Max Allowed:       ${maxConcurrency}`);
        lines.push(`  Peak Reached:      ${metrics.peakConcurrency}`);
        lines.push(`  Average:           ${metrics.averageConcurrency.toFixed(2)}`);
        lines.push(`  Utilization:       ${efficiency.utilization.toFixed(1)}%`);
        lines.push('');

        lines.push('🚀 Performance:');
        if (metrics.speedupVsSequential) {
            lines.push(`  Speedup:           ${metrics.speedupVsSequential.toFixed(2)}x`);
        }
        lines.push(`  Efficiency:        ${efficiency.efficiency.toFixed(1)}%`);
        lines.push(`  Parallel Efficiency: ${efficiency.parallelEfficiency.toFixed(1)}%`);
        lines.push('');

        const totalCPUTime = durations.reduce((a, b) => a + b, 0);
        const timeSaved = totalCPUTime - metrics.totalDuration;
        if (timeSaved > 0) {
            lines.push(`⏰ Time Saved: ${this.formatDuration(timeSaved)} vs sequential execution`);
            lines.push('');
        }

        lines.push('═══════════════════════════════════════════');
        lines.push('');

        return lines.join('\n');
    }

    private formatDuration(ms: number): string {
        if (ms < 1000) {
            return `${ms}ms`;
        }

        const seconds = Math.floor(ms / 1000);
        const minutes = Math.floor(seconds / 60);

        if (minutes > 0) {
            return `${minutes}m ${seconds % 60}s`;
        }

        return `${seconds}s`;
    }
}

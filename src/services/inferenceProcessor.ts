import { Server } from '@hapi/hapi';
import { ConfigService } from './config';
import { VideoStreamController } from './videoStreamProcessor';
import {
    IotcObjectDetectorInterface,
    IDeviceTelemetry
} from './objectDetectorDevice';
import * as moment from 'moment';
import * as Wreck from '@hapi/wreck';
import { bind } from '../utils';

export interface IObjectInference {
    type: string;
    entity: {
        box: {
            l: number,
            t: number,
            w: number,
            h: number
        },
        tag: {
            confidence: number;
            value: string
        }
    };
}

export const defaultDetectionClass = 'person';
export const defaultConfidenceThreshold = 70.0;
export const defaultInferenceInterval = 2;
export const defaultInferenceTimeout = 10;

export class InferenceProcessorService {
    private server: Server;
    private config: ConfigService;
    private iotcDevice: IDeviceTelemetry;
    private inferenceInterval: number;
    private detectionClasses: string[];
    private confidenceThreshold: number;
    private inferenceTimeout: number;

    private videoStreamController: VideoStreamController;
    private inferenceTimerId: NodeJS.Timeout;
    private lastInferenceTime: moment.Moment = moment.utc(0);
    private inferenceStartTime: moment.Moment = moment.utc();
    private lastInferenceImage: Buffer;

    constructor(
        server: Server,
        config: ConfigService,
        iotcDevice: IDeviceTelemetry,
        inferenceInterval: number,
        detectionClasses: string[],
        confidenceThreshold: number,
        inferenceTimeout: number) {

        this.server = server;
        this.config = config;
        this.iotcDevice = iotcDevice;
        this.inferenceInterval = inferenceInterval;
        this.detectionClasses = detectionClasses;
        this.confidenceThreshold = confidenceThreshold;
        this.inferenceTimeout = inferenceTimeout;
    }

    public async getHealth(): Promise<number> {
        return this.videoStreamController.getHealth();
    }

    public async startInferenceProcessor(rtspVideoUrl: string): Promise<void> {
        this.server.log(['InferenceProcessor', 'info'], `startInferenceProcessor`);

        if (this.videoStreamController) {
            await this.videoStreamController.stopVideoStreamProcessor();
        }

        this.videoStreamController = new VideoStreamController(this.server, this.config, this, this.inferenceInterval);

        await this.videoStreamController.startVideoStreamProcessor(rtspVideoUrl);
    }

    public async stopInferenceProcessor(): Promise<void> {
        clearInterval(this.inferenceTimerId);

        await this.videoStreamController.stopVideoStreamProcessor();

        this.videoStreamController = null;
    }

    @bind
    public async handleVideoFrame(imageData: Buffer): Promise<void> {
        const inferences = await this.processImage(imageData);

        const detectionCount = await this.processInferences(inferences);
        if (detectionCount > 0) {
            this.lastInferenceTime = moment.utc();

            if (this.lastInferenceImage) {
                this.lastInferenceImage = null;
            }

            this.lastInferenceImage = Buffer.from(imageData);
        }
    }

    @bind
    // @ts-ignore (data)
    public async handleData(data: any): Promise<void> {
        return;
    }

    public async videoStreamProcessingStarted(): Promise<void> {
        this.server.log(['InferenceProcessor', 'info'], `Video stream processor started`);

        this.lastInferenceTime = moment.utc(0);
        this.inferenceStartTime = moment.utc();

        this.inferenceTimerId = setInterval(async () => {
            await this.inferenceTimer();
        }, 1000);

        await this.iotcDevice.sendMeasurement({
            [IotcObjectDetectorInterface.Event.VideoStreamProcessingStarted]: '1'
        });
    }

    public async videoStreamProcessingStopped(code: number): Promise<void> {
        this.server.log(['InferenceProcessor', 'info'], `Video stream processor stopped with exit code: ${code}`);

        await this.iotcDevice.sendMeasurement({
            [IotcObjectDetectorInterface.Event.VideoStreamProcessingStopped]: `code: ${code}`
        });
    }

    public async videoStreamProcessingError(error: Error): Promise<void> {
        this.server.log(['InferenceProcessor', 'info'], `Video stream processor encountered an error: ${error.message}`);

        await this.iotcDevice.sendMeasurement({
            [IotcObjectDetectorInterface.Event.VideoStreamProcessingError]: error?.message || 'unknown'
        });
    }

    private async inferenceTimer(): Promise<void> {
        try {
            if (this.iotcDevice.debugTelemetry() === true) {
                this.server.log(['InferenceProcessor', 'info'], `Inference timer`);
            }

            if (moment.duration(moment.utc().diff(this.lastInferenceTime)) >= moment.duration(this.inferenceTimeout, 'seconds')) {
                if (this.lastInferenceTime.isAfter(moment.utc(0))) {
                    this.lastInferenceTime = moment.utc(0);

                    this.server.log(['InferenceProcessor', 'info'], `InferenceTimeout reached`);

                    await this.uploadInferenceImage();
                }

                this.inferenceStartTime = moment.utc();
            }
            else {
                if (moment.duration(moment.utc().diff(this.inferenceStartTime)) >= moment.duration(this.inferenceTimeout, 'seconds')) {
                    this.server.log(['InferenceProcessor', 'info'], `MaxVideoInferenceTime reached`);

                    this.lastInferenceTime = moment.utc(0);
                    this.inferenceStartTime = moment.utc();

                    await this.uploadInferenceImage();
                }
            }
        }
        catch (ex) {
            this.server.log(['InferenceProcessor', 'error'], `Inference timer error: ${ex.message}`);
        }
    }

    private async uploadInferenceImage(): Promise<void> {
        const imageUrl = await this.iotcDevice.uploadContent(this.lastInferenceImage);

        await this.iotcDevice.updateDeviceProperties({
            [IotcObjectDetectorInterface.Property.InferenceImageUrl]: imageUrl
        });
    }

    private async processImage(imageData: Buffer): Promise<IObjectInference[]> {
        try {
            const options = {
                payload: imageData,
                json: true
            };

            return this.postYolo3Request(options);
        }
        catch (ex) {
            this.server.log(['InferenceProcessor', 'error'], `Error processing image - yolov3 requests failed: ${ex.message}`);
        }

        return [];
    }

    private async processInferences(inferences: IObjectInference[]): Promise<number> {
        let detectionCount = 0;

        if (!Array.isArray(inferences)) {
            this.server.log(['InferenceProcessor', 'error'], `Missing inferences array`);
            return 0;
        }

        try {
            for (const inference of inferences) {
                const detectedClass = (inference.entity?.tag?.value || '').toUpperCase();
                const confidence = (inference.entity?.tag?.confidence || 0.0) * 100;

                if (this.detectionClasses.includes(detectedClass) && confidence >= this.confidenceThreshold) {
                    ++detectionCount;

                    await this.iotcDevice.sendMeasurement({
                        [IotcObjectDetectorInterface.Telemetry.Inference]: inference
                    });
                }
            }

            if (detectionCount > 0) {
                this.server.log(['InferenceProcessor', 'info'], `Detected ${detectionCount} objects of type(s) [${this.detectionClasses.join(',')}]`);

                await this.iotcDevice.sendMeasurement({
                    [IotcObjectDetectorInterface.Telemetry.InferenceCount]: detectionCount
                });
            }
        }
        catch (ex) {
            this.server.log(['InferenceProcessor', 'error'], `Error processing downstream message: ${ex.message}`);
        }

        return detectionCount;
    }

    private async postYolo3Request(options): Promise<IObjectInference[]> {
        try {
            const hostName = this.config.get('yoloHost') || 'yolov3';
            const { res, payload } = await Wreck.post(`http://${hostName}:8080/score`, options);

            if (res.statusCode < 200 || res.statusCode > 299) {
                this.server.log(['ipcCameraInterface', 'error'], `Response status code = ${res.statusCode}`);

                throw new Error(`Error statusCode: ${res.statusCode}, ${(payload as any)?.message || payload || 'An error occurred'}`);
            }

            return (payload as any)?.inferences || [];
        }
        catch (ex) {
            this.server.log(['ipcCameraInterface', 'error'], `makeRequest: ${ex.message}`);
            throw ex;
        }
    }
}

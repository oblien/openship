import { createOperatorNoticeOperations, createPublicNoticeOperations, type NoticeDependencies } from "../../../notices";
import * as service from "./notice.service";

export const noticesDependencies: NoticeDependencies = { list: service.list };
export const publicNoticeOperations = createPublicNoticeOperations(noticesDependencies);
export const operatorNoticeOperations = createOperatorNoticeOperations(service);

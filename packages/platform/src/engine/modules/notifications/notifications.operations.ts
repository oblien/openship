import { ForbiddenError } from "@repo/contracts";
import type { NotificationDependencies } from "../../../notifications";
import * as service from "./notifications.service";

export const notificationsDependencies: NotificationDependencies = {
  collection: {
    categories: service.listCategories,
    listChannels: service.listChannels,
    createChannel: service.createChannel,
    listSubscriptions: service.listSubscriptions,
    upsertSubscription: service.upsertSubscription,
    listDefaults: service.listDefaults,
    async upsertDefault(ctx, input) {
      // A regular member's broad feature access is not org administration.
      // Restricted principals already passed the explicit notifications:admin grant.
      if (ctx.role === "member") throw new ForbiddenError("Requires organization administration");
      return service.upsertDefault(ctx, input);
    },
    listDeliveries: service.listDeliveries,
    unseenCount: service.unseenCount,
  },
  resources: {
    updateChannel: service.updateChannel,
    testChannel: service.testChannel,
    removeChannel: service.deleteChannel,
    removeSubscription: service.deleteSubscription,
    markSeen: service.markSeen,
  },
};

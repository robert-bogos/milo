export default function customAlloyEvent(eventName, eventType = 'web.webinteraction.linkClicks') {
  window.alloy('sendEvent', {
    documentUnloading: true,
    xdm: {
      eventType,
      web: {
        webInteraction: {
          linkClicks: { value: 1 },
          type: 'other',
          name: eventName,
        },
      },
    },
    data: { _adobe_corpnew: { digitalData: { primaryEvent: { eventInfo: { eventName } } } } },
  });
}
